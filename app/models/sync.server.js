import { randomUUID } from "node:crypto";
import db from "../db.server";
import { unauthenticated } from "../shopify.server";

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

/* ---------- Master na variants vanchvu ---------- */
async function readMasterVariants(admin, productId) {
  const data = await gql(
    admin,
    `#graphql
      query MasterProduct($id: ID!) {
        product(id: $id) {
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
  return (data.product?.variants.nodes ?? []).map((v) => {
    let qty = null;
    if (v.inventoryItem?.tracked) {
      qty = v.inventoryItem.inventoryLevels.nodes.reduce(
        (sum, l) => sum + (l.quantities.find((q) => q.name === "available")?.quantity ?? 0),
        0,
      );
    }
    return { sku: v.sku, price: v.price, compareAtPrice: v.compareAtPrice ?? null, qty };
  });
}

/* ---------- Ek child store ma push karvu ---------- */
async function syncToChild(masterShop, childShop, masterVariants) {
  const { admin } = await unauthenticated.admin(childShop);

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

    const priceUpdates = new Map(); // productId -> [variant inputs]
    const qtyUpdates = [];
    const skuOf = new Map(); // variantId -> sku (log mate)

    for (const m of chunk) {
      const c = bySku.get(m.sku);
      if (!c) {
        await log(masterShop, childShop, m.sku, "match", "ERROR", "Child store ma aa SKU malyo nahi");
        continue;
      }
      const priceChanged =
        Number(c.price) !== Number(m.price) ||
        (c.compareAtPrice ?? null) !== (m.compareAtPrice ?? null) &&
          Number(c.compareAtPrice ?? -1) !== Number(m.compareAtPrice ?? -1);
      if (priceChanged) {
        const list = priceUpdates.get(c.product.id) ?? [];
        list.push({ id: c.id, price: m.price, compareAtPrice: m.compareAtPrice });
        priceUpdates.set(c.product.id, list);
        skuOf.set(c.id, m.sku);
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
}

/* ---------- Public API ---------- */
export async function syncProduct(masterShop, productGid) {
  console.log(`[sync] start master=${masterShop} product=${productGid}`);
  const link = await getMasterLink(masterShop);
  if (!link) {
    console.log(`[sync] SKIP: ${masterShop} is not a MASTER of any group`);
    return; // master nathi => kai nahi karvu
  }
  const children = link.group.links.filter((l) => l.role === "CHILD");
  if (!children.length) {
    console.log(`[sync] SKIP: group has no CHILD stores (links: ${link.group.links.map((l) => `${l.shop}:${l.role}`).join(", ")})`);
    return;
  }

  const { admin } = await unauthenticated.admin(masterShop);
  const all = await readMasterVariants(admin, productGid);
  const variants = all.filter((v) => v.sku);
  if (!variants.length) {
    console.log(`[sync] SKIP: ${all.length} variants but none has a SKU`);
    return;
  }
  console.log(`[sync] pushing ${variants.length} variants to ${children.map((c) => c.shop).join(", ")}`);

  for (const child of children) {
    try {
      await syncToChild(masterShop, child.shop, variants);
    } catch (e) {
      console.error(`[sync] ERROR child=${child.shop}:`, e);
      await log(masterShop, child.shop, null, "sync", "ERROR", e.message);
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