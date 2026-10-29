import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getInstallation, recordInstall } from "../models/installation.server";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  // Install record na hoy (jemke pehla thi installed app) to banavi do.
  let installation = await getInstallation(session.shop);
  if (!installation) installation = await recordInstall(session);

  const response = await admin.graphql(
    `#graphql
      query HomeOverview {
        shop {
          name
          myshopifyDomain
          plan { displayName }
        }
        productsCount { count }
        currentAppInstallation {
          accessScopes { handle }
        }
      }`,
  );
  const { data } = await response.json();

  return {
    shop: data.shop,
    productsCount: data.productsCount?.count ?? 0,
    scopes: data.currentAppInstallation.accessScopes.map((s) => s.handle),
    installedAt: installation.installedAt.toISOString(),
  };
};

export default function Home() {
  const { shop, productsCount, scopes, installedAt } = useLoaderData();

  return (
    <s-page heading="Dev Inventory Sync">
      <s-button slot="primary-action" href="/app/products">
        View products
      </s-button>

      <s-banner tone="success" heading="App successfully installed">
        <s-paragraph>
          {shop.name} ({shop.myshopifyDomain}) store ma app install thai gayi
          chhe.
        </s-paragraph>
      </s-banner>

      <s-section heading="Installation details">
        <s-stack direction="block" gap="small-200">
          <s-paragraph>
            <s-text type="strong">Store: </s-text>
            <s-text>{shop.name}</s-text>
          </s-paragraph>
          <s-paragraph>
            <s-text type="strong">Domain: </s-text>
            <s-text>{shop.myshopifyDomain}</s-text>
          </s-paragraph>
          <s-paragraph>
            <s-text type="strong">Plan: </s-text>
            <s-text>{shop.plan?.displayName ?? "-"}</s-text>
          </s-paragraph>
          <s-paragraph>
            <s-text type="strong">Installed on: </s-text>
            <s-text>{new Date(installedAt).toLocaleString()}</s-text>
          </s-paragraph>
          <s-paragraph>
            <s-text type="strong">Total products: </s-text>
            <s-text>{productsCount}</s-text>
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading="Permissions granted">
        <s-stack direction="inline" gap="small-200">
          {scopes.map((scope) => (
            <s-badge key={scope}>{scope}</s-badge>
          ))}
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Quick links">
        <s-stack direction="block" gap="small-200">
          <s-link href="/app/products">Product listing</s-link>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
