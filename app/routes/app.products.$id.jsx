import { randomUUID } from "node:crypto";
import { useEffect, useRef } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

const STATUS_TONE = { ACTIVE: "success", DRAFT: "info", ARCHIVED: "neutral" };
const lastId = (gid) => gid.split("/").pop();
const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // Shopify limit: 20 MB

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
          media(first: 20) {
            nodes {
              ... on MediaImage {
                id
                status
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
  const intent = form.get("intent");

  // ---- Images: navi image upload ----
  if (intent === "add_images") {
    const files = form.getAll("images").filter((f) => typeof f !== "string" && f.size > 0);
    if (!files.length) return { ok: false, errors: ["Koi image select nathi karyu."] };

    const valid = [];
    for (const f of files) {
      if (!f.type.startsWith("image/")) errors.push(`${f.name}: aa image file nathi.`);
      else if (f.size > MAX_IMAGE_BYTES) errors.push(`${f.name}: 20 MB thi moti chhe.`);
      else valid.push(f);
    }
    if (!valid.length) return { ok: false, errors };

    // 1) Staged upload URLs
    const stagedRes = await admin.graphql(
      `#graphql
        mutation StagedUploads($input: [StagedUploadInput!]!) {
          stagedUploadsCreate(input: $input) {
            stagedTargets { url resourceUrl parameters { name value } }
            userErrors { field message }
          }
        }`,
      {
        variables: {
          input: valid.map((f) => ({
            filename: f.name,
            mimeType: f.type,
            httpMethod: "POST",
            resource: "IMAGE",
            fileSize: String(f.size),
          })),
        },
      },
    );
    const staged = (await stagedRes.json()).data?.stagedUploadsCreate;
    if (!staged || staged.userErrors.length) {
      return {
        ok: false,
        errors: [...errors, ...(staged?.userErrors ?? []).map((e) => e.message)],
      };
    }

    // 2) File ne Shopify na storage par upload karo
    const media = [];
    for (let i = 0; i < valid.length; i++) {
      const t = staged.stagedTargets[i];
      const body = new FormData();
      for (const p of t.parameters) body.append(p.name, p.value);
      body.append("file", valid[i]); // "file" chhelle j hovu joiye
      const up = await fetch(t.url, { method: "POST", body });
      if (!up.ok) {
        errors.push(`${valid[i].name}: upload fail thayu (${up.status}).`);
        continue;
      }
      media.push({
        originalSource: t.resourceUrl,
        alt: valid[i].name.replace(/\.[^.]+$/, ""),
        mediaContentType: "IMAGE",
      });
    }

    // 3) Product sathe jodo
    if (media.length) {
      const res = await admin.graphql(
        `#graphql
          mutation AddProductMedia($product: ProductUpdateInput!, $media: [CreateMediaInput!]) {
            productUpdate(product: $product, media: $media) {
              userErrors { field message }
            }
          }`,
        { variables: { product: { id: productId }, media } },
      );
      const json = await res.json();
      errors.push(...(json.data?.productUpdate?.userErrors ?? []).map((e) => e.message));
    }
    return { ok: errors.length === 0, errors, imageAction: "add" };
  }

  // ---- Images: image delete ----
  if (intent === "delete_image") {
    const res = await admin.graphql(
      `#graphql
        mutation DeleteProductMedia($productId: ID!, $mediaIds: [ID!]!) {
          productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
            deletedMediaIds
            mediaUserErrors { field message }
          }
        }`,
      { variables: { productId, mediaIds: [String(form.get("mediaId"))] } },
    );
    const json = await res.json();
    errors.push(...(json.data?.productDeleteMedia?.mediaUserErrors ?? []).map((e) => e.message));
    if (json.errors?.length) errors.push(...json.errors.map((e) => e.message));
    return { ok: errors.length === 0, errors, imageAction: "delete" };
  }

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
  const imgFetcher = useFetcher();
  const fileRef = useRef(null);
  const shopify = useAppBridge();
  const currency = product.priceRangeV2.minVariantPrice.currencyCode;
  const date = (v) => new Date(v).toLocaleString();
  const medias = product.media.nodes.filter((m) => m.id);
  const imgBusy = imgFetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data?.ok) shopify.toast.show("Shopify ma product update thai gayu");
  }, [fetcher.data, shopify]);

  useEffect(() => {
    if (imgFetcher.data?.ok) {
      shopify.toast.show(
        imgFetcher.data.imageAction === "delete" ? "Image delete thai" : "Image upload thai gai",
      );
    }
  }, [imgFetcher.data, shopify]);

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

  const onFiles = (event) => {
    const files = Array.from(event.target.files ?? []);
    if (!files.length) return;
    const fd = new FormData();
    fd.set("intent", "add_images");
    for (const f of files) fd.append("images", f);
    imgFetcher.submit(fd, { method: "POST", encType: "multipart/form-data" });
    event.target.value = "";
  };

  const deleteImage = (mediaId) => {
    imgFetcher.submit({ intent: "delete_image", mediaId }, { method: "POST" });
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

      {imgFetcher.data && !imgFetcher.data.ok && (
        <s-banner tone="critical" heading="Image update na thai shakyu">
          <s-unordered-list>
            {imgFetcher.data.errors.map((msg) => (
              <s-list-item key={msg}>{msg}</s-list-item>
            ))}
          </s-unordered-list>
        </s-banner>
      )}

      {/* Images: alag section (form ni bahar) - upload/delete turant thay chhe, Save bar ni jarur nathi */}
      <s-section heading="Images">
        <s-stack direction="block" gap="base">
          {medias.length > 0 ? (
            <s-stack direction="inline" gap="base">
              {medias.map((m) => (
                <s-stack key={m.id} direction="block" gap="small-200" alignItems="center">
                  {m.image ? (
                    <s-thumbnail
                      size="large"
                      src={m.image.url}
                      alt={m.image.altText ?? product.title}
                    />
                  ) : (
                    <s-badge tone="info">Processing...</s-badge>
                  )}
                  <s-button
                    tone="critical"
                    variant="tertiary"
                    onClick={() => deleteImage(m.id)}
                    {...(imgBusy ? { disabled: true } : {})}
                  >
                    Delete
                  </s-button>
                </s-stack>
              ))}
            </s-stack>
          ) : (
            <s-paragraph>Aa product ma haju koi image nathi.</s-paragraph>
          )}

          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={onFiles}
          />
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-button
              onClick={() => fileRef.current?.click()}
              {...(imgBusy ? { loading: true } : {})}
            >
              Add images
            </s-button>
            <s-text tone="neutral">JPG/PNG/WebP, max 20 MB. Navi image process thata 1-2 second lage.</s-text>
          </s-stack>
        </s-stack>
      </s-section>

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