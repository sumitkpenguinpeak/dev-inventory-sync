import { randomUUID } from "node:crypto";
import { useEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

const lastId = (gid) => gid.split("/").pop();
const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // Shopify limit: 20 MB

// "Unavailable" ek alag quantity nathi, aa badhi no sum chhe
const UNAVAILABLE_NAMES = ["damaged", "quality_control", "reserved", "safety_stock"];
const qtyOf = (level, name) =>
  level.quantities.find((q) => q.name === name)?.quantity ?? 0;
const unavailableOf = (level) =>
  UNAVAILABLE_NAMES.reduce((sum, n) => sum + qtyOf(level, n), 0);

// Sidebar (Status / Product organization) no state ek j object ma
const makeOrg = (product) => ({
  status: product.status,
  productType: product.productType ?? "",
  vendor: product.vendor ?? "",
  tags: [...product.tags],
  collectionIds: product.collections.nodes
    .filter((c) => !c.ruleSet) // smart collection manually badli shakay nahi
    .map((c) => c.id),
  templateSuffix: product.templateSuffix ?? "",
});

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
          templateSuffix
          createdAt
          updatedAt
          onlineStoreUrl
          totalInventory
          tracksInventory
          options { name values }
          collections(first: 100) {
            nodes { id title ruleSet { appliedDisjunctively } }
          }
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
              barcode
              price
              compareAtPrice
              inventoryPolicy
              inventoryItem {
                id
                sku
                tracked
                inventoryLevels(first: 20) {
                  nodes {
                    location { id name }
                    quantities(names: ["available", "committed", "on_hand", "damaged", "quality_control", "reserved", "safety_stock"]) {
                      name
                      quantity
                    }
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

  // Collection picker mate: badha manual (custom) collections
  let allCollections = [];
  try {
    const colRes = await admin.graphql(
      `#graphql
        query ManualCollections {
          collections(first: 100, query: "collection_type:custom") {
            nodes { id title }
          }
        }`,
    );
    allCollections = (await colRes.json()).data?.collections?.nodes ?? [];
  } catch {
    allCollections = [];
  }

  // Publishing (sales channels). Permission na hoy to chupchap khali rakhvu.
  let publications = [];
  try {
    const pubRes = await admin.graphql(
      `#graphql
        query ProductPublications($id: ID!) {
          product(id: $id) {
            resourcePublicationsV2(first: 20) {
              nodes { isPublished publication { name } }
            }
          }
        }`,
      { variables: { id } },
    );
    const pj = await pubRes.json();
    publications = (pj.data?.product?.resourcePublicationsV2?.nodes ?? [])
      .filter((n) => n.isPublished && n.publication?.name)
      .map((n) => n.publication.name);
  } catch {
    publications = [];
  }

  return { product: data.product, allCollections, publications };
};

export const action = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();
  const productId = `gid://shopify/Product/${params.id}`;
  const errors = [];
  const intent = form.get("intent");

  // ---- Sidebar: Status + Product organization + Collections + Theme template ----
  if (intent === "save_organization") {
    let org;
    try {
      org = JSON.parse(String(form.get("org") || "{}"));
    } catch {
      return { ok: false, errors: ["Data valid nathi."], orgAction: true };
    }

    if (!["ACTIVE", "DRAFT", "ARCHIVED"].includes(org.status)) {
      return { ok: false, errors: ["Status valid nathi."], orgAction: true };
    }
    const tags = [
      ...new Set((org.tags ?? []).map((t) => String(t).trim()).filter(Boolean)),
    ];

    // 1) Product fields
    const res = await admin.graphql(
      `#graphql
        mutation UpdateProductOrganization($product: ProductUpdateInput!) {
          productUpdate(product: $product) {
            product { id }
            userErrors { field message }
          }
        }`,
      {
        variables: {
          product: {
            id: productId,
            status: org.status,
            productType: String(org.productType ?? "").trim(),
            vendor: String(org.vendor ?? "").trim(),
            tags,
            templateSuffix: org.templateSuffix ? String(org.templateSuffix) : null,
          },
        },
      },
    );
    const json = await res.json();
    if (json.errors?.length) errors.push(...json.errors.map((e) => e.message));
    errors.push(...(json.data?.productUpdate?.userErrors ?? []).map((e) => e.message));

    // 2) Collections (fakat manual collections add/remove)
    const curRes = await admin.graphql(
      `#graphql
        query CurrentCollections($id: ID!) {
          product(id: $id) {
            collections(first: 100) {
              nodes { id ruleSet { appliedDisjunctively } }
            }
          }
        }`,
      { variables: { id: productId } },
    );
    const cur = (await curRes.json()).data?.product?.collections?.nodes ?? [];
    const manualCurrent = cur.filter((c) => !c.ruleSet).map((c) => c.id);
    const wanted = (org.collectionIds ?? []).map(String);
    const toAdd = wanted.filter((c) => !manualCurrent.includes(c));
    const toRemove = manualCurrent.filter((c) => !wanted.includes(c));

    for (const collectionId of toAdd) {
      const r = await admin.graphql(
        `#graphql
          mutation AddToCollection($id: ID!, $productIds: [ID!]!) {
            collectionAddProducts(id: $id, productIds: $productIds) {
              userErrors { field message }
            }
          }`,
        { variables: { id: collectionId, productIds: [productId] } },
      );
      const j = await r.json();
      if (j.errors?.length) errors.push(...j.errors.map((e) => e.message));
      errors.push(...(j.data?.collectionAddProducts?.userErrors ?? []).map((e) => e.message));
    }
    for (const collectionId of toRemove) {
      const r = await admin.graphql(
        `#graphql
          mutation RemoveFromCollection($id: ID!, $productIds: [ID!]!) {
            collectionRemoveProducts(id: $id, productIds: $productIds) {
              userErrors { field message }
            }
          }`,
        { variables: { id: collectionId, productIds: [productId] } },
      );
      const j = await r.json();
      if (j.errors?.length) errors.push(...j.errors.map((e) => e.message));
      errors.push(...(j.data?.collectionRemoveProducts?.userErrors ?? []).map((e) => e.message));
    }

    return { ok: errors.length === 0, errors: [...new Set(errors)], orgAction: true };
  }

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

  // ---- 2. Price / Compare-at price / Barcode / Sell when out of stock ----
  const variants = new Map();
  for (const [key, raw] of form.entries()) {
    const [field, variantId] = key.split(":");
    if (!["price", "compareAt", "barcode", "policy"].includes(field)) continue;
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
    } else if (field === "compareAt") {
      if (value === "") {
        entry.compareAtPrice = null;
      } else if (Number(value) >= 0) {
        entry.compareAtPrice = value;
      } else {
        errors.push("Compare-at price valid number hovo joiye.");
        continue;
      }
    } else if (field === "barcode") {
      entry.barcode = value;
    } else if (field === "policy") {
      // CONTINUE = "Sell when out of stock" on, DENY = off
      if (value !== "CONTINUE" && value !== "DENY") continue;
      entry.inventoryPolicy = value;
    }
    variants.set(variantId, entry);
  }

  if (variants.size && errors.length === 0) {
    const res = await admin.graphql(
      `#graphql
        mutation UpdateVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) {
            productVariants { id }
            userErrors { field message }
          }
        }`,
      { variables: { productId, variants: [...variants.values()] } },
    );
    const json = await res.json();
    errors.push(
      ...(json.data?.productVariantsBulkUpdate?.userErrors ?? []).map((e) => e.message),
    );
    if (json.errors?.length) errors.push(...json.errors.map((e) => e.message));
  }

  // ---- 3. Inventory item: Inventory tracked + SKU ----
  // Aa quantity set karva pehla thavu joiye (tracked off hoy to quantity set na thay)
  const items = new Map();
  for (const [key, raw] of form.entries()) {
    const [field, itemId] = key.split(":");
    if (field !== "tracked" && field !== "sku") continue;
    const entry = items.get(itemId) ?? {};
    entry[field] = String(raw).trim();
    items.set(itemId, entry);
  }

  if (errors.length === 0) {
    for (const [itemId, entry] of items) {
      const input = {};
      const origTracked = String(form.get(`origTracked:${itemId}`) ?? "");
      const origSku = String(form.get(`origSku:${itemId}`) ?? "");
      if (entry.tracked !== undefined && entry.tracked !== origTracked) {
        input.tracked = entry.tracked === "true";
      }
      if (entry.sku !== undefined && entry.sku !== origSku) {
        input.sku = entry.sku;
      }
      if (!Object.keys(input).length) continue;

      const res = await admin.graphql(
        `#graphql
          mutation UpdateInventoryItem($id: ID!, $input: InventoryItemInput!) {
            inventoryItemUpdate(id: $id, input: $input) {
              userErrors { field message }
            }
          }`,
        {
          variables: { id: `gid://shopify/InventoryItem/${itemId}`, input },
        },
      );
      const json = await res.json();
      errors.push(
        ...(json.data?.inventoryItemUpdate?.userErrors ?? []).map((e) => e.message),
      );
      if (json.errors?.length) errors.push(...json.errors.map((e) => e.message));
    }
  }

  // ---- 4. Inventory (available quantity per location) ----
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

const pillStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "4px 10px",
  borderRadius: 8,
  background: "var(--p-color-bg-surface-secondary, #f1f1f1)",
  fontSize: 13,
  lineHeight: "20px",
  whiteSpace: "nowrap",
};
const pillValueStyle = {
  padding: "0 6px",
  borderRadius: 6,
  background: "var(--p-color-bg-surface-tertiary, #e3e3e3)",
  fontWeight: 600,
};

/* ---------- Darek variant no Inventory card (Shopify admin jevo layout) ---------- */
function VariantInventory({ variant, showTitle }) {
  const item = variant.inventoryItem;
  const vid = lastId(variant.id);
  const itemId = lastId(item.id);
  const levels = item.inventoryLevels.nodes;

  const [tracked, setTracked] = useState(item.tracked);
  const [sellOutOfStock, setSellOutOfStock] = useState(
    variant.inventoryPolicy === "CONTINUE",
  );
  const [open, setOpen] = useState(false);

  return (
    <s-section heading={showTitle ? `Inventory: ${variant.title}` : "Inventory"}>
      <s-stack direction="block" gap="base">
        {/* Form ma jata hidden values */}
        <input type="hidden" name={`tracked:${itemId}`} value={String(tracked)} />
        <input type="hidden" name={`origTracked:${itemId}`} value={String(item.tracked)} />
        <input type="hidden" name={`origSku:${itemId}`} value={variant.sku ?? ""} />
        <input
          type="hidden"
          name={`policy:${vid}`}
          value={sellOutOfStock ? "CONTINUE" : "DENY"}
        />

        <s-stack direction="inline" justifyContent="space-between" alignItems="center">
          <s-text type="strong">Quantities</s-text>
          <s-switch
            label="Inventory tracked"
            onChange={(e) => setTracked(e.currentTarget.checked)}
            {...(tracked ? { checked: true } : {})}
          />
        </s-stack>

        {!tracked ? (
          <s-text tone="neutral">Aa variant ma inventory track nathi thati.</s-text>
        ) : !item.tracked ? (
          <s-text tone="neutral">
            Save karya pachhi location wise quantity edit kari shakso.
          </s-text>
        ) : levels.length === 0 ? (
          <s-text tone="neutral">No locations</s-text>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Locations</s-table-header>
              <s-table-header listSlot="labeled" format="numeric">Unavailable</s-table-header>
              <s-table-header listSlot="labeled" format="numeric">Committed</s-table-header>
              <s-table-header listSlot="labeled" format="numeric">Available</s-table-header>
              <s-table-header listSlot="labeled" format="numeric">On hand</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {levels.map((lvl) => {
                const available = qtyOf(lvl, "available");
                const committed = qtyOf(lvl, "committed");
                const unavailable = unavailableOf(lvl);
                // On hand = available + committed + unavailable (Shopify no formula)
                const onHand = available + committed + unavailable;
                const locId = lastId(lvl.location.id);
                return (
                  <s-table-row key={lvl.location.id}>
                    <s-table-cell>{lvl.location.name}</s-table-cell>
                    <s-table-cell>{unavailable}</s-table-cell>
                    <s-table-cell>{committed}</s-table-cell>
                    <s-table-cell>
                      <input
                        type="hidden"
                        name={`orig:${itemId}:${locId}`}
                        value={available}
                      />
                      <s-number-field
                        label={`Available at ${lvl.location.name}`}
                        labelAccessibilityVisibility="exclusive"
                        name={`qty:${itemId}:${locId}`}
                        min={0}
                        step={1}
                        defaultValue={String(available)}
                      />
                    </s-table-cell>
                    <s-table-cell>{onHand}</s-table-cell>
                  </s-table-row>
                );
              })}
            </s-table-body>
          </s-table>
        )}

        {tracked && item.tracked && levels.length > 0 && (
          <s-stack direction="block" gap="small-200">
            {levels.map((lvl) => (
              <s-link
                key={lvl.location.id}
                href={`shopify:admin/products/inventory/${itemId}/inventory_history?location_id=${lastId(lvl.location.id)}`}
                target="_blank"
              >
                View adjustment history{levels.length > 1 ? ` (${lvl.location.name})` : ""}
              </s-link>
            ))}
          </s-stack>
        )}

        {/* SKU / Barcode / Sell when out of stock: collapsible (Shopify jevi pill row) */}
        <div style={{ borderTop: "1px solid var(--p-color-border, #e3e3e3)", paddingTop: 12 }}>
          <div
            role="button"
            tabIndex={0}
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setOpen((o) => !o);
              }
            }}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              cursor: "pointer",
            }}
          >
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
              <span style={pillStyle}>
                SKU
                {variant.sku ? <span style={pillValueStyle}>{variant.sku}</span> : null}
              </span>
              <span style={pillStyle}>
                Barcodes
                {variant.barcode ? <span style={pillValueStyle}>{variant.barcode}</span> : null}
              </span>
              <span style={pillStyle}>
                Sell when out of stock
                <span style={pillValueStyle}>{sellOutOfStock ? "On" : "Off"}</span>
              </span>
            </div>
            <span
              aria-hidden="true"
              style={{
                display: "inline-block",
                width: 8,
                height: 8,
                borderRight: "2px solid currentColor",
                borderBottom: "2px solid currentColor",
                transform: open ? "rotate(-135deg)" : "rotate(45deg)",
                transition: "transform 0.15s",
                marginRight: 6,
              }}
            />
          </div>

          {/* hidden na rakhva (display:none) jethi form ma hamesha jay */}
          <div style={{ display: open ? "block" : "none", paddingTop: 12 }}>
            <s-stack direction="block" gap="base">
              <s-stack direction="inline" gap="base">
                <s-text-field
                  label="SKU (Stock keeping unit)"
                  name={`sku:${itemId}`}
                  defaultValue={variant.sku ?? ""}
                />
                <s-text-field
                  label="Barcode (ISBN, UPC, GTIN, etc.)"
                  name={`barcode:${vid}`}
                  defaultValue={variant.barcode ?? ""}
                />
              </s-stack>
              <s-checkbox
                label="Sell when out of stock"
                details="Customer out of stock hoy tyare pan order kari shake."
                onChange={(e) => setSellOutOfStock(e.currentTarget.checked)}
                {...(sellOutOfStock ? { checked: true } : {})}
              />
            </s-stack>
          </div>
        </div>
      </s-stack>
    </s-section>
  );
}

export default function ProductDetails() {
  const { product, allCollections, publications } = useLoaderData();
  const fetcher = useFetcher();
  const imgFetcher = useFetcher();
  const orgFetcher = useFetcher();
  const fileRef = useRef(null);
  const shopify = useAppBridge();
  const currency = product.priceRangeV2.minVariantPrice.currencyCode;
  const date = (v) => new Date(v).toLocaleString();
  const medias = product.media.nodes.filter((m) => m.id);
  const imgBusy = imgFetcher.state !== "idle";

  // ---- Sidebar state ----
  const initialOrg = makeOrg(product);
  const initialKey = JSON.stringify(initialOrg);
  const [org, setOrg] = useState(initialOrg);
  const [tagInput, setTagInput] = useState("");
  const orgDirty = JSON.stringify(org) !== initialKey;
  const orgBusy = orgFetcher.state !== "idle";

  // Save pachhi (ke product badlay tyare) sidebar fresh values sathe reset karo
  useEffect(() => {
    setOrg(JSON.parse(initialKey));
  }, [initialKey]);

  const update = (patch) => setOrg((o) => ({ ...o, ...patch }));

  const addTag = () => {
    const parts = tagInput
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (!parts.length) return;
    update({ tags: [...new Set([...org.tags, ...parts])] });
    setTagInput("");
  };
  const removeTag = (t) => update({ tags: org.tags.filter((x) => x !== t) });

  const collectionTitle = new Map([
    ...allCollections.map((c) => [c.id, c.title]),
    ...product.collections.nodes.map((c) => [c.id, c.title]),
  ]);
  const smartCollections = product.collections.nodes.filter((c) => c.ruleSet);
  const availableCollections = allCollections.filter(
    (c) => !org.collectionIds.includes(c.id),
  );
  const addCollection = (id) => {
    if (id && !org.collectionIds.includes(id)) {
      update({ collectionIds: [...org.collectionIds, id] });
    }
  };
  const removeCollection = (id) =>
    update({ collectionIds: org.collectionIds.filter((x) => x !== id) });

  const saveOrg = () => {
    orgFetcher.submit(
      { intent: "save_organization", org: JSON.stringify(org) },
      { method: "POST" },
    );
  };

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

  useEffect(() => {
    if (orgFetcher.data?.ok) shopify.toast.show("Product organization update thai gayu");
  }, [orgFetcher.data, shopify]);

  // Save pachhi form fresh values sathe pharithi banay te mate key.
  const formKey = JSON.stringify([
    product.updatedAt,
    product.variants.nodes.map((v) => [
      v.price,
      v.compareAtPrice,
      v.sku,
      v.barcode,
      v.inventoryPolicy,
      v.inventoryItem.tracked,
      v.inventoryItem.inventoryLevels.nodes.map((l) =>
        l.quantities.map((q) => `${q.name}:${q.quantity}`).join(","),
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

  // Theme template: Default + (jo set hoy to) current suffix
  const templateOptions = [{ value: "", label: "Default product" }];
  if (product.templateSuffix) {
    templateOptions.push({
      value: product.templateSuffix,
      label: `product.${product.templateSuffix}`,
    });
  }

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

      {orgFetcher.data && !orgFetcher.data.ok && (
        <s-banner tone="critical" heading="Status / organization update na thai shakyu">
          <s-unordered-list>
            {orgFetcher.data.errors.map((msg) => (
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

          <s-section heading="Variants: pricing" padding="none">
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">Variant</s-table-header>
                <s-table-header listSlot="labeled">
                  Price ({currency})
                </s-table-header>
                <s-table-header listSlot="labeled">Compare at</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {product.variants.nodes.map((v) => {
                  const vid = lastId(v.id);
                  return (
                    <s-table-row key={v.id}>
                      <s-table-cell>{v.title}</s-table-cell>
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
                    </s-table-row>
                  );
                })}
              </s-table-body>
            </s-table>
          </s-section>

          {/* Darek variant mate Shopify jevo Inventory card */}
          {product.variants.nodes.map((v) => (
            <VariantInventory
              key={v.id}
              variant={v}
              showTitle={product.variants.nodes.length > 1}
            />
          ))}
        </s-stack>
      </form>

      {/* ---------------- Sidebar ---------------- */}

      <s-section slot="aside" heading="Status">
        <s-select
          label="Status"
          labelAccessibilityVisibility="exclusive"
          value={org.status}
          onChange={(e) => update({ status: e.currentTarget.value })}
        >
          <s-option value="ACTIVE">Active</s-option>
          <s-option value="DRAFT">Draft</s-option>
          <s-option value="ARCHIVED">Archived</s-option>
        </s-select>
      </s-section>

      {publications.length > 0 && (
        <s-section slot="aside" heading="Publishing">
          <s-stack direction="inline" gap="small-200">
            {publications.map((name) => (
              <s-badge key={name}>{name}</s-badge>
            ))}
          </s-stack>
        </s-section>
      )}

      <s-section slot="aside" heading="Product organization">
        <s-stack direction="block" gap="base">
          <s-text-field
            label="Type"
            value={org.productType}
            onInput={(e) => update({ productType: e.currentTarget.value })}
            onChange={(e) => update({ productType: e.currentTarget.value })}
          />

          <s-text-field
            label="Vendor"
            value={org.vendor}
            onInput={(e) => update({ vendor: e.currentTarget.value })}
            onChange={(e) => update({ vendor: e.currentTarget.value })}
          />

          <s-stack direction="block" gap="small-200">
            <s-select
              label="Collections"
              value=""
              onChange={(e) => addCollection(e.currentTarget.value)}
            >
              <s-option value="">Add collections</s-option>
              {availableCollections.map((c) => (
                <s-option key={c.id} value={c.id}>
                  {c.title}
                </s-option>
              ))}
            </s-select>
            {(org.collectionIds.length > 0 || smartCollections.length > 0) && (
              <s-stack direction="inline" gap="small-200">
                {org.collectionIds.map((id) => (
                  <s-clickable-chip
                    key={id}
                    accessibilityLabel={`Remove ${collectionTitle.get(id) ?? id}`}
                    onClick={() => removeCollection(id)}
                  >
                    {collectionTitle.get(id) ?? id} ×
                  </s-clickable-chip>
                ))}
                {smartCollections.map((c) => (
                  <s-badge key={c.id} tone="neutral">
                    {c.title} (automated)
                  </s-badge>
                ))}
              </s-stack>
            )}
          </s-stack>

          <s-stack direction="block" gap="small-200">
            <s-stack direction="inline" gap="small-200" alignItems="end">
              <s-text-field
                label="Tags"
                placeholder="Tag lakho (comma thi alag karo)"
                value={tagInput}
                onInput={(e) => setTagInput(e.currentTarget.value)}
                onChange={(e) => setTagInput(e.currentTarget.value)}
              />
              <s-button onClick={addTag}>Add</s-button>
            </s-stack>
            {org.tags.length > 0 && (
              <s-stack direction="inline" gap="small-200">
                {org.tags.map((t) => (
                  <s-clickable-chip
                    key={t}
                    accessibilityLabel={`Remove ${t}`}
                    onClick={() => removeTag(t)}
                  >
                    {t} ×
                  </s-clickable-chip>
                ))}
              </s-stack>
            )}
          </s-stack>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Theme template">
        <s-select
          label="Theme template"
          labelAccessibilityVisibility="exclusive"
          value={org.templateSuffix}
          onChange={(e) => update({ templateSuffix: e.currentTarget.value })}
        >
          {templateOptions.map((o) => (
            <s-option key={o.value} value={o.value}>
              {o.label}
            </s-option>
          ))}
        </s-select>
      </s-section>

      <s-section slot="aside">
        <s-button
          variant="primary"
          onClick={saveOrg}
          {...(orgBusy ? { loading: true } : {})}
          {...(!orgDirty ? { disabled: true } : {})}
        >
          Save changes
        </s-button>
      </s-section>

      <s-section slot="aside" heading="Details">
        <s-stack direction="block" gap="small-200">
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