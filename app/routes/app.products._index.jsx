import { useLoaderData, useNavigate, useNavigation, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

const PAGE_SIZE = 20;

const STATUS_TONE = { ACTIVE: "success", DRAFT: "info", ARCHIVED: "neutral" };

// Search term ne Shopify search syntax mate safe banave (prefix match).
function buildQuery(q, status) {
  const parts = [];
  const tokens = (q ?? "")
    .replace(/["():\\]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length) parts.push(tokens.map((t) => `${t}*`).join(" "));
  if (["active", "draft", "archived"].includes(status)) {
    parts.push(`status:${status}`);
  }
  return parts.join(" ") || null;
}

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? "";
  const status = url.searchParams.get("status") ?? "all";
  const after = url.searchParams.get("after");
  const before = url.searchParams.get("before");

  const paging = before
    ? { last: PAGE_SIZE, before }
    : { first: PAGE_SIZE, after: after || null };

  const response = await admin.graphql(
    `#graphql
      query ProductListing($first: Int, $after: String, $last: Int, $before: String, $query: String) {
        products(first: $first, after: $after, last: $last, before: $before, query: $query, sortKey: UPDATED_AT, reverse: true) {
          nodes {
            id
            title
            status
            vendor
            productType
            totalInventory
            tracksInventory
            featuredMedia {
              preview { image { url altText } }
            }
            priceRangeV2 {
              minVariantPrice { amount currencyCode }
              maxVariantPrice { amount currencyCode }
            }
          }
          pageInfo {
            hasNextPage
            hasPreviousPage
            startCursor
            endCursor
          }
        }
      }`,
    { variables: { ...paging, query: buildQuery(q, status) } },
  );
  const { data } = await response.json();

  return {
    q,
    status,
    products: data.products.nodes,
    pageInfo: data.products.pageInfo,
  };
};

function formatPrice({ minVariantPrice: min, maxVariantPrice: max }) {
  const fmt = (m) =>
    new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: m.currencyCode,
    }).format(Number(m.amount));
  return min.amount === max.amount ? fmt(min) : `${fmt(min)} - ${fmt(max)}`;
}

function inventoryLabel(p) {
  if (!p.tracksInventory) return "Not tracked";
  return `${p.totalInventory} in stock`;
}

const numericId = (gid) => gid.split("/").pop();

export default function ProductListing() {
  const { q, status, products, pageInfo } = useLoaderData();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const isLoading = navigation.state === "loading";

  const go = (changes) => {
    const next = new URLSearchParams(searchParams);
    next.delete("after");
    next.delete("before");
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    navigate(`?${next.toString()}`);
  };

  return (
    <s-page heading="Products">
      <s-section padding="none">
        <s-table
          paginate
          loading={isLoading || undefined}
          hasNextPage={pageInfo.hasNextPage}
          hasPreviousPage={pageInfo.hasPreviousPage}
          onNextPage={() => go({ after: pageInfo.endCursor })}
          onPreviousPage={() => go({ before: pageInfo.startCursor })}
        >
          <s-grid slot="filters" gap="small-200" gridTemplateColumns="1fr auto">
            <s-search-field
              label="Search products"
              labelAccessibilityVisibility="exclusive"
              placeholder="Search by title, SKU, vendor..."
              value={q}
              onChange={(e) => go({ q: e.currentTarget.value.trim() })}
            />
            <s-select
              label="Status"
              labelAccessibilityVisibility="exclusive"
              value={status}
              onChange={(e) =>
                go({ status: e.currentTarget.value === "all" ? "" : e.currentTarget.value })
              }
            >
              <s-option value="all">All</s-option>
              <s-option value="active">Active</s-option>
              <s-option value="draft">Draft</s-option>
              <s-option value="archived">Archived</s-option>
            </s-select>
          </s-grid>

          <s-table-header-row>
            <s-table-header listSlot="primary">Product</s-table-header>
            <s-table-header listSlot="inline">Status</s-table-header>
            <s-table-header listSlot="secondary">Inventory</s-table-header>
            <s-table-header listSlot="secondary">Type</s-table-header>
            <s-table-header listSlot="secondary">Vendor</s-table-header>
            <s-table-header listSlot="labeled" format="numeric">
              Price
            </s-table-header>
          </s-table-header-row>

          <s-table-body>
            {products.map((p) => {
              const image = p.featuredMedia?.preview?.image;
              return (
                <s-table-row key={p.id}>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small" alignItems="center">
                      <s-thumbnail
                        size="small"
                        src={image?.url ?? ""}
                        alt={image?.altText ?? p.title}
                      />
                      <s-link href={`/app/products/${numericId(p.id)}`}>
                        {p.title}
                      </s-link>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge tone={STATUS_TONE[p.status] ?? "neutral"}>
                      {p.status.charAt(0) + p.status.slice(1).toLowerCase()}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>{inventoryLabel(p)}</s-table-cell>
                  <s-table-cell>{p.productType || "-"}</s-table-cell>
                  <s-table-cell>{p.vendor || "-"}</s-table-cell>
                  <s-table-cell>{formatPrice(p.priceRangeV2)}</s-table-cell>
                </s-table-row>
              );
            })}
          </s-table-body>
        </s-table>

        {products.length === 0 && !isLoading && (
          <s-box padding="large">
            <s-paragraph>
              Koi product malyo nahi. Search ke filter badli ne juo.
            </s-paragraph>
          </s-box>
        )}
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
