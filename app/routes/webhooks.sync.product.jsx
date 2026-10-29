import { authenticate } from "../shopify.server";
import { scheduleProductSync } from "../models/sync.server";

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  if (payload?.admin_graphql_api_id) {
    scheduleProductSync(shop, payload.admin_graphql_api_id); // master na hoy to ignore thay
  }
  return new Response();
};