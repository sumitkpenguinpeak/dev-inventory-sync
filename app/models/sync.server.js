import { randomUUID } from "node:crypto";
import db from "../db.server";
import { unauthenticated } from "../shopify.server";

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

/* ---------- Master product vanchvu (handle ni base par match thase) ---------- */
async function readMasterProduct(admin, productId) {
  const data = await gql(
    admin,
    `#graphql
      query MasterProduct($id: ID!) {
        product(id: $id) {
          handle
          title
          descriptionHtml
          status
          vendor
          productType
          tags
          templateSuffix
          variants(first: 100) {
            nodes {
              title
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
  return {
    handle: p.handle,
    title: p.title,
    descriptionHtml: p.descriptionHtml ?? "",
    status: p.status,
    vendor: p.vendor ?? "",
    productType: p.productType ?? "",
    tags: p.tags ?? [],
    templateSuffix: p.templateSuffix ?? null,
    variants: p.variants.nodes.map((v) => {
      let qty = null;
      if (v.inventoryItem?.tracked) {
        qty = v.inventoryItem.inventoryLevels.nodes.reduce(
          (sum, l) => sum + (l.quantities.find((q) => q.name === "available")?.quantity ?? 0),
          0,
        );
      }
      return { title: v.title, price: v.price, compareAtPrice: v.compareAtPrice ?? null, qty };
    }),
  };
}

const sameTags = (a, b) => [...a].sort().join("\u0000") === [...b].sort().join("\u0000");
const samePrice = (a, b) =>
  (a ?? null) === null || (b ?? null) === null ? (a ?? null) === (b ?? null) : Number(a) === Number(b);

/* ---------- Ek child store ma push karvu (product handle thi match) ---------- */
async function syncToChild(masterShop, childShop, mp) {
  const { admin } = await unauthenticated.admin(childShop);

  const data = await gql(
    admin,
    `#graphql
      query ChildProduct($handle: String!) {
        productByIdentifier(identifier: { handle: $handle }) {
          id
          title
          descriptionHtml
          status
          vendor
          productType
          tags
          templateSuffix
          variants(first: 100) {
            nodes {
              id
              title
              price
              compareAtPrice
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
        }
      }`,
    { handle: mp.handle },
  );
  const child = data.productByIdentifier;
  if (!child) {
    await log(masterShop, childShop, mp.handle, "match", "ERROR",
      "Child store ma aa handle valo product malyo nahi");
    return;
  }

  /* ---- 1. Product fields (title, description, status, vendor, type, tags, template) ---- */
  const input = { id: child.id };
  const changed = [];
  const setIf = (field, differs, value) => {
    if (differs) { input[field] = value; changed.push(field); }
  };
  setIf("title", child.title !== mp.title, mp.title);
  setIf("descriptionHtml", (child.descriptionHtml ?? "") !== mp.descriptionHtml, mp.descriptionHtml);
  setIf("status", child.status !== mp.status, mp.status);
  setIf("vendor", (child.vendor ?? "") !== mp.vendor, mp.vendor);
  setIf("productType", (child.productType ?? "") !== mp.productType, mp.productType);
  setIf("tags", !sameTags(child.tags ?? [], mp.tags), mp.tags);
  setIf("templateSuffix", (child.templateSuffix ?? null) !== mp.templateSuffix, mp.templateSuffix);

  if (changed.length) {
    const r = await gql(
      admin,
      `#graphql
        mutation SyncProduct($product: ProductUpdateInput!) {
          productUpdate(product: $product) {
            userErrors { field message }
          }
        }`,
      { product: input },
    );
    const errs = r.productUpdate?.userErrors ?? [];
    await log(masterShop, childShop, mp.handle, changed.join(", "),
      errs.length ? "ERROR" : "OK", errs.map((e) => e.message).join("; ") || "updated");
  }

  /* ---- 2. Variants: price, compare-at, inventory (variant title thi match) ---- */
  const byTitle = new Map();
  for (const n of child.variants.nodes) if (!byTitle.has(n.title)) byTitle.set(n.title, n);

  const priceUpdates = [];
  const qtyUpdates = [];

  for (const m of mp.variants) {
    const c = byTitle.get(m.title);
    const label = `${mp.handle} / ${m.title}`;
    if (!c) {
      await log(masterShop, childShop, label, "match", "ERROR",
        "Child store ma aa variant (title) malyo nahi");
      continue;
    }
    if (!samePrice(c.price, m.price) || !samePrice(c.compareAtPrice, m.compareAtPrice)) {
      priceUpdates.push({ id: c.id, price: m.price, compareAtPrice: m.compareAtPrice, _label: label });
    }
    const level = c.inventoryItem?.inventoryLevels.nodes[0];
    if (m.qty !== null && c.inventoryItem?.tracked && level) {
      const cur = level.quantities.find((x) => x.name === "available")?.quantity ?? 0;
      if (cur !== m.qty) {
        qtyUpdates.push({
          inventoryItemId: c.inventoryItem.id,
          locationId: level.location.id,
          quantity: m.qty,
          changeFromQuantity: cur,
          _label: label,
        });
      }
    }
  }

  if (priceUpdates.length) {
    const variants = priceUpdates.map(({ _label, ...rest }) => rest);
    const r = await gql(
      admin,
      `#graphql
        mutation SyncPrices($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) {
            userErrors { field message }
          }
        }`,
      { productId: child.id, variants },
    );
    const errs = r.productVariantsBulkUpdate.userErrors;
    for (const u of priceUpdates) {
      await log(masterShop, childShop, u._label, "price",
        errs.length ? "ERROR" : "OK", errs.map((e) => e.message).join("; ") || `${u.price}`);
    }
  }

  if (qtyUpdates.length) {
    const quantities = qtyUpdates.map(({ _label, ...rest }) => rest);
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
      await log(masterShop, childShop, u._label, "inventory",
        errs.length ? "ERROR" : "OK", errs.map((e) => e.message).join("; ") || `${u.quantity}`);
    }
  }
}

/* ---------- Public API ---------- */
export async function syncProduct(masterShop, productGid) {
  console.log(`[sync] start master=${masterShop} product=${productGid}`);
  const link = await getMasterLink(masterShop);
  if (!link) {
    console.log(`[sync] SKIP: ${masterShop} is not a MASTER of any group`);
    return;
  }
  const children = link.group.links.filter((l) => l.role === "CHILD");
  if (!children.length) {
    console.log(`[sync] SKIP: group has no CHILD stores`);
    return;
  }

  const { admin } = await unauthenticated.admin(masterShop);
  const mp = await readMasterProduct(admin, productGid);
  if (!mp) {
    console.log(`[sync] SKIP: product ${productGid} not found in master`);
    return;
  }
  console.log(`[sync] pushing handle=${mp.handle} to ${children.map((c) => c.shop).join(", ")}`);

  for (const child of children) {
    try {
      await syncToChild(masterShop, child.shop, mp);
    } catch (e) {
      console.error(`[sync] ERROR child=${child.shop}:`, e);
      await log(masterShop, child.shop, mp.handle, "sync", "ERROR", e.message);
    }
  }
}

// Webhook ghani var fire thay chhe, etle 3 sec ma aavela events ne ek kari didha.
const pending = new Map();
export function scheduleProductSync(masterShop, productGid) {
  const key = `${masterShop}|${productGid}`;
  clearTimeout(pending.get(key));
  pending.set(
    key,
    setTimeout(() => {
      pending.delete(key);
      syncProduct(masterShop, productGid).catch((e) => console.error("sync failed", e));
    }, 3000),
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