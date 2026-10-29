import { randomUUID } from "node:crypto";
import { useEffect } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

const STATUS_TONE = { ACTIVE: "success", DRAFT: "info", ARCHIVED: "neutral" };
const lastId = (gid) => gid.split("/").pop();

export const loader = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const id = `gid://shopify/Product/${params.id}`;

  const response = await admin.graphql(
    `#graphql
      query ProductDetails($id: ID!) {
        product(id: $id) {
          id
          title
          handle
          status
          descriptionHtml
          vendor
          productType
          tags
          createdAt
          updatedAt
          onlineStoreUrl
          totalInventory
          tracksInventory
          options { name values }
          media(first: 10) {
            nodes {
              ... on MediaImage {
                id
                image { url altText }
              }
            }
          }
          variants(first: 100) {
            nodes {
              id
              title
              sku
              price
              compareAtPrice
              inventoryItem {
                id
                tracked
                inventoryLevels(first: 20) {
                  nodes {
                    location { id name }
                    quantities(names: ["available"]) { name quantity }
                  }
                }
              }
            }
          }
          priceRangeV2 {
            minVariantPrice { currencyCode }
          }
        }
      }`,
    { variables: { id } },
  );
  const { data } = await response.json();

  if (!data.product) {
    throw new Response("Product not found", { status: 404 });
  }
  return { product: data.product };
};

export const action = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();
  const productId = `gid://shopify/Product/${params.id}`;
  const errors = [];

  // ---- 1. Description ----
  if (form.has("description")) {
    const res = await admin.graphql(
      `#graphql
        mutation UpdateProductDescription($product: ProductUpdateInput!) {
          productUpdate(product: $product) {
            product { id }
            userErrors { field message }
          }
        }`,
      {
        variables: {
          product: { id: productId, descriptionHtml: String(form.get("description")) },
        },
      },
    );
    const json = await res.json();
    errors.push(...json.data.productUpdate.userErrors.map((e) => e.message));
  }

  // ---- 2. Price / Compare-at price ----
  const variants = new Map();
  for (const [key, raw] of form.entries()) {
    const [field, variantId] = key.split(":");
    if (field !== "price" && field !== "compareAt") continue;
    const value = String(raw).trim();
    const entry = variants.get(variantId) ?? {
      id: `gid://shopify/ProductVariant/${variantId}`,
    };

    if (field === "price") {
      if (value === "" || !(Number(value) >= 0)) {
        errors.push("Price valid number hovo joiye (0 ke tethi vadhu).");
        continue;
      }
      entry.price = value;
    } else if (value === "") {
      entry.compareAtPrice = null;
    } else if (Number(value) >= 0) {
      entry.compareAtPrice = value;
    } else {
      errors.push("Compare-at price valid number hovo joiye.");
      continue;
    }
    variants.set(variantId, entry);
  }

  if (variants.size && errors.length === 0) {
    const res = await admin.graphql(
      `#graphql
        mutation UpdateVariantPrices($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) {
            productVariants { id }
            userErrors { field message }
          }
        }`,
      { variables: { productId, variants: [...variants.values()] } },
    );
    const json = await res.json();
    errors.push(
      ...json.data.productVariantsBulkUpdate.userErrors.map((e) => e.message),
    );
  }

  // ---- 3. Inventory (available quantity per location) ----
  const quantities = [];
  for (const [key, raw] of form.entries()) {
    const [field, itemId, locationId] = key.split(":");
    if (field !== "qty") continue;
    const value = String(raw).trim();
    if (value === "") continue;
    const qty = Number(value);
    if (!Number.isInteger(qty) || qty < 0) {
      errors.push("Inventory 0 ke tethi vadhu purn sankhya (whole number) hovi joiye.");
      continue;
    }
    // Form ma hidden "orig" value hoy chhe: kharekhar badlayelu j moklo.
    const origRaw = form.get(`orig:${itemId}:${locationId}`);
    const orig = origRaw === null || origRaw === "" ? null : Number(origRaw);
    if (orig !== null && orig === qty) continue;
    quantities.push({
      inventoryItemId: `gid://shopify/InventoryItem/${itemId}`,
      locationId: `gid://shopify/Location/${locationId}`,
      quantity: qty,
      // API 2026-04+: farajiyat. Current quantity = concurrency check,
      // null = check vagar set.
      changeFromQuantity: orig,
    });
  }

  if (quantities.length && errors.length === 0) {
    // API 2026-04+ ma inventorySetQuantities field par @idempotent key farajiyat chhe.
    const res = await admin.graphql(
      `#graphql
        mutation SetInventory($input: InventorySetQuantitiesInput!) {
          inventorySetQuantities(input: $input) @idempotent(key: "${randomUUID()}") {
            inventoryAdjustmentGroup { id }
            userErrors { field message }
          }
        }`,
      {
        variables: {
          input: {
            name: "available",
            reason: "correction",
            quantities,
          },
        },
      },
    );
    const json = await res.json();
    errors.push(
      ...(json.data?.inventorySetQuantities?.userErrors ?? []).map((e) => e.message),
    );
    if (json.errors?.length) errors.push(...json.errors.map((e) => e.message));
  }

  return { ok: errors.length === 0, errors: [...new Set(errors)] };
};

export default function ProductDetails() {
  const { product } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const currency = product.priceRangeV2.minVariantPrice.currencyCode;
  const date = (v) => new Date(v).toLocaleString();
  const images = product.media.nodes.filter((m) => m.image);

  useEffect(() => {
    if (fetcher.data?.ok) shopify.toast.show("Shopify ma product update thai gayu");
  }, [fetcher.data, shopify]);

  // Save pachhi form fresh values sathe pharithi banay te mate key.
  const formKey = JSON.stringify([
    product.updatedAt,
    product.variants.nodes.map((v) => [
      v.price,
      v.compareAtPrice,
      v.inventoryItem.inventoryLevels.nodes.map(
        (l) => l.quantities.find((q) => q.name === "available")?.quantity,
      ),
    ]),
  ]);

  const handleSubmit = (event) => {
    event.preventDefault();
    fetcher.submit(new FormData(event.currentTarget), { method: "POST" });
  };

  return (
    <s-page heading={product.title}>
      <s-link slot="breadcrumb-actions" href="/app/products">
        Products
      </s-link>
      {product.onlineStoreUrl && (
        <s-button
          slot="secondary-actions"
          href={product.onlineStoreUrl}
          target="_blank"
        >
          View in store
        </s-button>
      )}

      {fetcher.data && !fetcher.data.ok && (
        <s-banner tone="critical" heading="Update na thai shakyu">
          <s-unordered-list>
            {fetcher.data.errors.map((msg) => (
              <s-list-item key={msg}>{msg}</s-list-item>
            ))}
          </s-unordered-list>
        </s-banner>
      )}

      <form
        data-save-bar
        key={formKey}
        onSubmit={handleSubmit}
      >
        <s-stack direction="block" gap="base">
          <s-section heading="Description">
            <s-text-area
              label="Description"
              labelAccessibilityVisibility="exclusive"
              name="description"
              rows={8}
              details="HTML supported (jemke <p>, <strong>, <ul>)."
              defaultValue={product.descriptionHtml}
            />
          </s-section>

          {images.length > 0 && (
            <s-section heading="Images">
              <s-stack direction="inline" gap="base">
                {images.map((m) => (
                  <s-thumbnail
                    key={m.id}
                    size="large"
                    src={m.image.url}
                    alt={m.image.altText ?? product.title}
                  />
                ))}
              </s-stack>
            </s-section>
          )}

          <s-section heading="Variants: price & inventory" padding="none">
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">Variant</s-table-header>
                <s-table-header listSlot="secondary">SKU</s-table-header>
                <s-table-header listSlot="labeled">
                  Price ({currency})
                </s-table-header>
                <s-table-header listSlot="labeled">Compare at</s-table-header>
                <s-table-header listSlot="labeled">Inventory</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {product.variants.nodes.map((v) => {
                  const vid = lastId(v.id);
                  const item = v.inventoryItem;
                  const levels = item.tracked ? item.inventoryLevels.nodes : [];
                  return (
                    <s-table-row key={v.id}>
                      <s-table-cell>{v.title}</s-table-cell>
                      <s-table-cell>{v.sku || "-"}</s-table-cell>
                      <s-table-cell>
                        <s-number-field
                          label="Price"
                          labelAccessibilityVisibility="exclusive"
                          name={`price:${vid}`}
                          min={0}
                          step={0.01}
                          defaultValue={v.price}
                        />
                      </s-table-cell>
                      <s-table-cell>
                        <s-number-field
                          label="Compare at price"
                          labelAccessibilityVisibility="exclusive"
                          name={`compareAt:${vid}`}
                          min={0}
                          step={0.01}
                          defaultValue={v.compareAtPrice ?? ""}
                        />
                      </s-table-cell>
                      <s-table-cell>
                        {levels.length === 0 ? (
                          <s-text tone="neutral">
                            {item.tracked ? "No locations" : "Not tracked"}
                          </s-text>
                        ) : (
                          <s-stack direction="block" gap="small-200">
                            {levels.map((lvl) => {
                              const available =
                                lvl.quantities.find((q) => q.name === "available")
                                  ?.quantity ?? 0;
                              return (
                                <s-stack key={lvl.location.id} direction="block">
                                <input
                                  type="hidden"
                                  name={`orig:${lastId(item.id)}:${lastId(lvl.location.id)}`}
                                  value={available}
                                />
                                <s-number-field
                                  label={lvl.location.name}
                                  labelAccessibilityVisibility={
                                    levels.length === 1 ? "exclusive" : "visible"
                                  }
                                  name={`qty:${lastId(item.id)}:${lastId(lvl.location.id)}`}
                                  min={0}
                                  step={1}
                                  defaultValue={String(available)}
                                />
                                </s-stack>
                              );
                            })}
                          </s-stack>
                        )}
                      </s-table-cell>
                    </s-table-row>
                  );
                })}
              </s-table-body>
            </s-table>
          </s-section>
        </s-stack>
      </form>

      <s-section slot="aside" heading="Status">
        <s-badge tone={STATUS_TONE[product.status] ?? "neutral"}>
          {product.status.charAt(0) + product.status.slice(1).toLowerCase()}
        </s-badge>
      </s-section>

      <s-section slot="aside" heading="Product organization">
        <s-stack direction="block" gap="small-200">
          <s-paragraph>
            <s-text type="strong">Vendor: </s-text>
            <s-text>{product.vendor || "-"}</s-text>
          </s-paragraph>
          <s-paragraph>
            <s-text type="strong">Type: </s-text>
            <s-text>{product.productType || "-"}</s-text>
          </s-paragraph>
          <s-paragraph>
            <s-text type="strong">Handle: </s-text>
            <s-text>{product.handle}</s-text>
          </s-paragraph>
          <s-paragraph>
            <s-text type="strong">Total inventory: </s-text>
            <s-text>
              {product.tracksInventory ? product.totalInventory : "Not tracked"}
            </s-text>
          </s-paragraph>
          {product.tags.length > 0 && (
            <s-stack direction="inline" gap="small-200">
              {product.tags.map((t) => (
                <s-badge key={t}>{t}</s-badge>
              ))}
            </s-stack>
          )}
        </s-stack>
      </s-section>

      {product.options.length > 0 && (
        <s-section slot="aside" heading="Options">
          <s-stack direction="block" gap="small-200">
            {product.options.map((o) => (
              <s-paragraph key={o.name}>
                <s-text type="strong">{o.name}: </s-text>
                <s-text>{o.values.join(", ")}</s-text>
              </s-paragraph>
            ))}
          </s-stack>
        </s-section>
      )}

      <s-section slot="aside" heading="Dates">
        <s-stack direction="block" gap="small-200">
          <s-text>Created: {date(product.createdAt)}</s-text>
          <s-text>Updated: {date(product.updatedAt)}</s-text>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
