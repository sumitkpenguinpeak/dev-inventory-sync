import { randomUUID } from "node:crypto";
import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { parseSyncSettings } from "./stores.server";


const esc = (s) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

async function gql(admin, query, variables) {
  const res = await admin.graphql(query, { variables });
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "));
  return json.data;
}

async function log(masterShop, childShop, sku, field, status, message) {
  await db.syncLog
    .create({ data: { masterShop, childShop, sku, field, status, message } })
    .catch(() => {});
}

async function getMasterLink(shop) {
  return db.storeLink.findFirst({
    where: { shop, role: "MASTER" },
    include: { group: { include: { links: true } } },
  });
}

// Image URL ma thi file name (CDN par alag store ma URL alag hoy, file name same rahe chhe)
const fileName = (url) =>
  decodeURIComponent((url ?? "").split("?")[0].split("/").pop() ?? "").toLowerCase();
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const norm = (t) => (t ?? "").trim().toLowerCase();

/* ---------- Master na product + variants vanchvu ---------- */
async function readMaster(admin, productId) {
  const data = await gql(
    admin,
    `#graphql
      query MasterProduct($id: ID!) {
        product(id: $id) {
          title
          descriptionHtml
          status
          productType
          vendor
          tags
          templateSuffix
          collections(first: 100) {
            nodes { title ruleSet { appliedDisjunctively } }
          }
          media(first: 20) {
            nodes { ... on MediaImage { status image { url altText } } }
          }
          variants(first: 100) {
            nodes {
              sku
              price
              compareAtPrice
              inventoryItem {
                tracked
                inventoryLevels(first: 50) {
                  nodes { quantities(names: ["available"]) { name quantity } }
                }
              }
            }
          }
        }
      }`,
    { id: productId },
  );
  const p = data.product;
  if (!p) return null;

  const variants = p.variants.nodes.map((v) => {
    let qty = null;
    if (v.inventoryItem?.tracked) {
      qty = v.inventoryItem.inventoryLevels.nodes.reduce(
        (sum, l) => sum + (l.quantities.find((q) => q.name === "available")?.quantity ?? 0),
        0,
      );
    }
    return { sku: v.sku, price: v.price, compareAtPrice: v.compareAtPrice ?? null, qty };
  });

  return {
    fields: {
      title: p.title,
      descriptionHtml: p.descriptionHtml,
      status: p.status,
      productType: p.productType,
      vendor: p.vendor,
      tags: p.tags,
      templateSuffix: p.templateSuffix ?? null,
      collections: p.collections.nodes.filter((c) => !c.ruleSet).map((c) => c.title),
      // Master ni badhi image READY hoy to j images sync karvi
      imagesReady: p.media.nodes.every((m) => !m.status || m.status === "READY"),
      images: p.media.nodes
        .filter((m) => m.image)
        .map((m) => ({ url: m.image.url, alt: m.image.altText ?? "" })),
    },
    variants,
  };
}

/* ---------- Collections sync (title thi match, kemke ID store pramane alag hoy) ---------- */

// Child store na badha manual collections: title -> id
async function getChildCollections(admin) {
  const map = new Map();
  let after = null;
  do {
    const d = await gql(
      admin,
      `#graphql
        query ChildCollections($after: String) {
          collections(first: 100, after: $after, query: "collection_type:custom") {
            nodes { id title }
            pageInfo { hasNextPage endCursor }
          }
        }`,
      { after },
    );
    for (const c of d.collections.nodes) map.set(norm(c.title), c.id);
    after = d.collections.pageInfo.hasNextPage ? d.collections.pageInfo.endCursor : null;
  } while (after);
  return map;
}

async function syncCollections(admin, masterShop, childShop, sku, c, masterTitles, byTitle) {
  const wanted = new Set(masterTitles.map(norm));
  const current = c.collections.nodes.filter((x) => !x.ruleSet); // smart collection ne aadvo nahi
  const currentTitles = new Set(current.map((x) => norm(x.title)));

  const toAdd = [];
  const missing = [];
  for (const t of masterTitles) {
    if (currentTitles.has(norm(t))) continue;
    const id = byTitle.get(norm(t));
    if (id) toAdd.push(id);
    else missing.push(t);
  }
  const toRemove = current.filter((x) => !wanted.has(norm(x.title))).map((x) => x.id);

  if (missing.length) {
    await log(masterShop, childShop, sku, "collections", "ERROR",
      `Child ma collection nathi: ${missing.join(", ")}`);
  }
  if (!toAdd.length && !toRemove.length) return;

  const errs = [];
  for (const id of toAdd) {
    const r = await gql(
      admin,
      `#graphql
        mutation AddToCollection($id: ID!, $productIds: [ID!]!) {
          collectionAddProducts(id: $id, productIds: $productIds) {
            userErrors { field message }
          }
        }`,
      { id, productIds: [c.id] },
    );
    errs.push(...r.collectionAddProducts.userErrors.map((e) => e.message));
  }
  for (const id of toRemove) {
    const r = await gql(
      admin,
      `#graphql
        mutation RemoveFromCollection($id: ID!, $productIds: [ID!]!) {
          collectionRemoveProducts(id: $id, productIds: $productIds) {
            userErrors { field message }
          }
        }`,
      { id, productIds: [c.id] },
    );
    errs.push(...r.collectionRemoveProducts.userErrors.map((e) => e.message));
  }
  await log(masterShop, childShop, sku, "collections",
    errs.length ? "ERROR" : "OK", errs.join("; ") || "updated");
}

/* ---------- Child ma product-level fields (title, image, status...) ---------- */
async function syncProductFields(admin, masterShop, childShop, productSkus, mf, F) {
  const data = await gql(
    admin,
    `#graphql
      query ChildProducts($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Product {
            id
            title
            descriptionHtml
            status
            productType
            vendor
            tags
            templateSuffix
            collections(first: 100) {
              nodes { id title ruleSet { appliedDisjunctively } }
            }
            media(first: 50) {
              nodes { id ... on MediaImage { image { url } } }
            }
          }
        }
      }`,
    { ids: [...productSkus.keys()] },
  );

  // Child na collections (title -> id) ek j var vanchvu
  const childCollections = F.collections ? await getChildCollections(admin) : null;

  for (const c of data.nodes.filter(Boolean)) {
    const sku = productSkus.get(c.id);
    const input = { id: c.id };
    const changed = [];

    // Collections: `continue` pehla j rakhvu, nahi to bijhu kai na badlay tyare skip thai jay
    if (F.collections) {
      try {
        await syncCollections(admin, masterShop, childShop, sku, c, mf.collections, childCollections);
      } catch (err) {
        await log(masterShop, childShop, sku, "collections", "ERROR", err.message);
      }
    }

    const set = (key, field, flag = true) => {
      if (flag && c[key] !== mf[key]) {
        input[key] = mf[key];
        changed.push(field);
      }
    };
    if (F.title) set("title", "title");
    if (F.description) set("descriptionHtml", "description");
    if (F.status) set("status", "status");
    if (F.productType) set("productType", "type");
    if (F.template && (c.templateSuffix ?? null) !== (mf.templateSuffix ?? null)) {
      input.templateSuffix = mf.templateSuffix ?? null;
      changed.push("template");
    }
    if (F.vendor) set("vendor", "vendor");
    if (F.tags && !sameList([...c.tags].sort(), [...mf.tags].sort())) {
      input.tags = mf.tags;
      changed.push("tags");
    }

    // Images: pehla navi add karo, update safal thay pachhi juni delete karo
    let media = null;
    let oldMediaIds = null;
    console.log("[sync][images]", childShop, sku, {
      enabled: F.images,
      masterReady: mf.imagesReady,
      masterFiles: mf.images.map((i) => fileName(i.url)),
      childFiles: c.media.nodes.filter((m) => m.image).map((m) => fileName(m.image.url)),
    });
    if (F.images && mf.imagesReady) {
      const childFiles = c.media.nodes.filter((m) => m.image).map((m) => fileName(m.image.url));
      const masterFiles = mf.images.map((i) => fileName(i.url));
      const childBusy = c.media.nodes.some((m) => !m.image); // child ma image haju processing ma
      if (!childBusy && !sameList(childFiles, masterFiles)) {
        oldMediaIds = c.media.nodes.map((m) => m.id);
        if (mf.images.length) {
          media = mf.images.map((i) => ({
            originalSource: i.url,
            alt: i.alt,
            mediaContentType: "IMAGE",
          }));
        }
        changed.push("images");
      }
    }

    if (Object.keys(input).length === 1 && !media && !oldMediaIds?.length) continue; // kai badlayu nathi

    const r = await gql(
      admin,
      `#graphql
        mutation SyncProduct($product: ProductUpdateInput!, $media: [CreateMediaInput!]) {
          productUpdate(product: $product, media: $media) {
            userErrors { field message }
          }
        }`,
      { product: input, media },
    );
    const errs = r.productUpdate.userErrors;
    await log(masterShop, childShop, sku, changed.join(", "),
      errs.length ? "ERROR" : "OK", errs.map((e) => e.message).join("; ") || "updated");

    // Navi image add thai gai pachhi j juni delete karo
    if (oldMediaIds?.length && !errs.length) {
      try {
        const d = await gql(
          admin,
          `#graphql
            mutation DeleteOldMedia($fileIds: [ID!]!) {
              fileDelete(fileIds: $fileIds) {
                userErrors { field message }
              }
            }`,
          { fileIds: oldMediaIds },
        );
        const e = d.fileDelete.userErrors;
        if (e.length) {
          await log(masterShop, childShop, sku, "images-delete", "ERROR", e.map((x) => x.message).join("; "));
        }
      } catch (err) {
        console.error("[sync][images] delete failed:", err.message);
        await log(masterShop, childShop, sku, "images-delete", "ERROR", err.message);
      }
    }
  }
}

/* ---------- Ek child store ma push karvu ---------- */
async function syncToChild(masterShop, childShop, master, F) {
  const { admin } = await unauthenticated.admin(childShop);
  const masterVariants = master.variants;
  const productSkus = new Map(); // child productId -> sku

  for (let i = 0; i < masterVariants.length; i += 25) {
    const chunk = masterVariants.slice(i, i + 25);
    const q = chunk.map((v) => `sku:'${esc(v.sku)}'`).join(" OR ");

    const data = await gql(
      admin,
      `#graphql
        query ChildVariants($q: String!) {
          productVariants(first: 50, query: $q) {
            nodes {
              id
              sku
              price
              compareAtPrice
              product { id }
              inventoryItem {
                id
                tracked
                inventoryLevels(first: 1) {
                  nodes {
                    location { id }
                    quantities(names: ["available"]) { name quantity }
                  }
                }
              }
            }
          }
        }`,
      { q },
    );

    const bySku = new Map();
    for (const n of data.productVariants.nodes) if (!bySku.has(n.sku)) bySku.set(n.sku, n);
    console.log("[sync] child", childShop, "matched", bySku.size, "of", chunk.length);

    const priceUpdates = new Map(); // productId -> [variant inputs]
    const qtyUpdates = [];
    const skuOf = new Map(); // variantId -> sku

    for (const m of chunk) {
      const c = bySku.get(m.sku);
      if (!c) {
        await log(masterShop, childShop, m.sku, "match", "ERROR", "Child store ma aa SKU malyo nahi");
        continue;
      }
      if (!productSkus.has(c.product.id)) productSkus.set(c.product.id, m.sku);

      if (F.price) {
        const priceChanged =
          Number(c.price) !== Number(m.price) ||
          Number(c.compareAtPrice ?? -1) !== Number(m.compareAtPrice ?? -1);
        if (priceChanged) {
          const list = priceUpdates.get(c.product.id) ?? [];
          list.push({ id: c.id, price: m.price, compareAtPrice: m.compareAtPrice });
          priceUpdates.set(c.product.id, list);
          skuOf.set(c.id, m.sku);
        }
      }

      const level = c.inventoryItem?.inventoryLevels.nodes[0];
      if (F.inventory && m.qty !== null && c.inventoryItem?.tracked && level) {
        const cur = level.quantities.find((x) => x.name === "available")?.quantity ?? 0;
        if (cur !== m.qty) {
          qtyUpdates.push({
            inventoryItemId: c.inventoryItem.id,
            locationId: level.location.id,
            quantity: m.qty,
            changeFromQuantity: cur,
            _sku: m.sku,
          });
        }
      }
    }

    for (const [productId, variants] of priceUpdates) {
      const r = await gql(
        admin,
        `#graphql
          mutation SyncPrices($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
            productVariantsBulkUpdate(productId: $productId, variants: $variants) {
              userErrors { field message }
            }
          }`,
        { productId, variants },
      );
      const errs = r.productVariantsBulkUpdate.userErrors;
      for (const v of variants) {
        await log(masterShop, childShop, skuOf.get(v.id), "price",
          errs.length ? "ERROR" : "OK", errs.map((e) => e.message).join("; ") || `${v.price}`);
      }
    }

    if (qtyUpdates.length) {
      const quantities = qtyUpdates.map(({ _sku, ...rest }) => rest);
      const r = await gql(
        admin,
        `#graphql
          mutation SyncInventory($input: InventorySetQuantitiesInput!) {
            inventorySetQuantities(input: $input) @idempotent(key: "${randomUUID()}") {
              userErrors { field message }
            }
          }`,
        { input: { name: "available", reason: "correction", quantities } },
      );
      const errs = r.inventorySetQuantities?.userErrors ?? [];
      for (const u of qtyUpdates) {
        await log(masterShop, childShop, u._sku, "inventory",
          errs.length ? "ERROR" : "OK", errs.map((e) => e.message).join("; ") || `${u.quantity}`);
      }
    }
  }

  if (productSkus.size) {
    await syncProductFields(admin, masterShop, childShop, productSkus, master.fields, F);
  }
}

/* ---------- Public API ---------- */
export async function syncProduct(masterShop, productGid, attempt = 0) {
  console.log("[sync] start", masterShop, productGid, "attempt", attempt);
  const link = await getMasterLink(masterShop);
  if (!link) return console.log("[sync] STOP: aa store master nathi (group nathi)");
  const children = link.group.links.filter((l) => l.role === "CHILD");
  if (!children.length) return console.log("[sync] STOP: koi child nathi");
  const F = parseSyncSettings(link.group.settings);

  const { admin } = await unauthenticated.admin(masterShop);
  const master = await readMaster(admin, productGid);
  if (!master) return;
  master.variants = master.variants.filter((v) => v.sku);

  // Master ni image haju processing ma hoy to 5 sec pachhi pachho try karo (max ~1 minute)
  if (F.images && !master.fields.imagesReady && attempt < 12) {
    console.log("[sync] master image processing, retry in 5s, attempt", attempt + 1);
    scheduleProductSync(masterShop, productGid, attempt + 1, 5000);
  }
  console.log("[sync] children:", children.map((c) => c.shop), "variants with SKU:", master.variants.length);
  if (!master.variants.length) return;

  for (const child of children) {
    try {
      await syncToChild(masterShop, child.shop, master, F);
    } catch (e) {
      await log(masterShop, child.shop, null, "sync", "ERROR", e.message);
    }
  }
}

// Webhook ghani var fire thay chhe, etle 3 sec ma aavela events ne ek kari didha.
const pending = new Map();
export function scheduleProductSync(masterShop, productGid, attempt = 0, delay = 3000) {
  const key = `${masterShop}|${productGid}`;
  clearTimeout(pending.get(key));
  pending.set(
    key,
    setTimeout(() => {
      pending.delete(key);
      syncProduct(masterShop, productGid, attempt).catch((e) => console.error("sync failed", e));
    }, delay),
  );
}

export async function scheduleSyncByInventoryItem(masterShop, inventoryItemGid) {
  if (!(await getMasterLink(masterShop))) return;
  const { admin } = await unauthenticated.admin(masterShop);
  const data = await gql(
    admin,
    `#graphql
      query ItemProduct($id: ID!) {
        inventoryItem(id: $id) { variant { product { id } } }
      }`,
    { id: inventoryItemGid },
  );
  const productId = data.inventoryItem?.variant?.product?.id;
  if (productId) scheduleProductSync(masterShop, productId);
}

export async function syncAll(masterShop) {
  const link = await getMasterLink(masterShop);
  if (!link) throw new Error("Fakat master store sync chalavi shake.");
  const { admin } = await unauthenticated.admin(masterShop);

  let after = null;
  let products = 0;
  do {
    const data = await gql(
      admin,
      `#graphql
        query AllProducts($after: String) {
          products(first: 50, after: $after) {
            nodes { id }
            pageInfo { hasNextPage endCursor }
          }
        }`,
      { after },
    );
    for (const p of data.products.nodes) {
      await syncProduct(masterShop, p.id);
      products++;
    }
    after = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (after);

  return { products };
}