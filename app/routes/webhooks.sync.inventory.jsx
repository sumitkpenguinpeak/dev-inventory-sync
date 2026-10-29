import { authenticate } from "../shopify.server";
import { scheduleSyncByInventoryItem } from "../models/sync.server";

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  if (payload?.inventory_item_id) {
    scheduleSyncByInventoryItem(
      shop,
      `gid://shopify/InventoryItem/${payload.inventory_item_id}`,
    ).catch((e) => console.error("inventory sync failed", e));
  }
  return new Response();
};