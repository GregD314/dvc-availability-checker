import cron from "node-cron";

const BASE44_EXPORT_URL = "https://dvc365.base44.app/functions/exportAvailabilityCheckQueue";
const BASE44_INGEST_URL = "https://dvc365.base44.app/functions/ingestAvailabilityCheck";

const QUEUE_SECRET = "93a405ee8da16cf5aacd7d401ccdb9c572bad112eb679482e33d6d3a5ccb5422";
const INGEST_SECRET = "ed10dcbc76950eb78d0317125a67828ad0f1a16757d15e9ff076e4a268887fa7";

async function fetchQueue() {
  const res = await fetch(BASE44_EXPORT_URL, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({
      secret: QUEUE_SECRET,
      provider_slug: "official-dvc-checker"
    })
  });

  return await res.json();
}

async function sendResult(result) {
  await fetch(BASE44_INGEST_URL, {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body: JSON.stringify({
      secret: INGEST_SECRET,
      provider_slug:"official-dvc-checker",
      results:[result]
    })
  });
}

async function runCheck() {

  console.log("Checking queue");

  const queue = await fetchQueue();

  if(!queue.queue_items || queue.queue_items.length === 0){
    console.log("No items");
    return;
  }

  for(const item of queue.queue_items){

    const result = {
      queue_item_id:item.queue_item_id,
      resort_name:item.resort_name,
      room_type_name:item.room_type_name,
      check_in_date:item.check_in_date,
      check_out_date:item.check_out_date,
      nights:item.nights,
      status:"unknown",
      confidence_score:0.5,
      checked_at:new Date().toISOString(),
      notes:"automatic check",
      raw_result_json:{}
    };

    await sendResult(result);

  }

}

cron.schedule("*/15 * * * *", runCheck);

runCheck();
