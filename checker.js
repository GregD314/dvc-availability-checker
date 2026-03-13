import cron from "node-cron";

const BASE44_EXPORT_URL =
  process.env.QUEUE_EXPORT_URL ||
  "https://dvc365.base44.app/functions/exportAvailabilityCheckQueue";

const BASE44_INGEST_URL =
  process.env.INGEST_URL ||
  "https://dvc365.base44.app/functions/ingestAvailabilityCheck";

const BASE44_MARK_FAILED_URL =
  process.env.MARK_FAILED_URL ||
  "https://dvc365.base44.app/functions/markQueueItemFailed";

const QUEUE_SECRET =
  process.env.QUEUE_SECRET ||
  "93a405ee8da16cf5aacd7d401ccdb9c572bad112eb679482e33d6d3a5ccb5422";

const INGEST_SECRET =
  process.env.INGEST_SECRET ||
  "ed10dcbc76950eb78d0317125a67828ad0f1a16757d15e9ff076e4a268887fa7";

const PROVIDER_SLUG =
  process.env.PROVIDER_SLUG || "official-dvc-checker";

// ---------- helpers ----------

function normalize(text) {
  return (text || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const text = await res.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url}: ${text}`);
  }

  return data;
}

// ---------- Base44 calls ----------

async function getQueue() {
  const queue = await postJson(BASE44_EXPORT_URL, {
    secret: QUEUE_SECRET,
    provider_slug: PROVIDER_SLUG
  });

  return queue;
}

async function sendResult(result) {
  return await postJson(BASE44_INGEST_URL, {
    secret: INGEST_SECRET,
    provider_slug: PROVIDER_SLUG,
    results: [result]
  });
}

async function markFailed(queueItemId, errorMessage) {
  try {
    await postJson(BASE44_MARK_FAILED_URL, {
      queue_item_id: queueItemId,
      error_message: errorMessage
    });
  } catch (err) {
    console.error("Could not mark failed item:", queueItemId, err.message);
  }
}

// ---------- broker mappings ----------

const BROKER_RESORT_NAMES = {
  "Animal Kingdom Villas - Jambo House": "Animal Kingdom Villas - Jambo House",
  "Animal Kingdom Villas - Kidani Village": "Animal Kingdom Villas - Kidani Village",
  "Bay Lake Tower": "Bay Lake Tower",
  "Beach Club Villas": "Beach Club Villas",
  "BoardWalk Villas": "Boardwalk Villas",
  "Boulder Ridge Villas": "Boulder Ridge",
  "Copper Creek Villas & Cabins": "Copper Creek",
  "Grand Floridian Villas": "Grand Floridian Resort",
  "Old Key West": "Old Key West Resort",
  "Polynesian Villas & Bungalows": "Polynesian Villas",
  "Riviera Resort": "Riviera",
  "Saratoga Springs": "Saratoga Springs Resort",
  "The Cabins at Disney’s Fort Wilderness Resort": "Fort Wilderness Campground",
  "Aulani": "Aulani",
  "Hilton Head Island Resort": "Hilton Head Island Resort",
  "Vero Beach Villas": "Vero Beach Resort",
  "Grand Californian": "Grand Californian",
  "The Villas at Disneyland Hotel": "Disneyland Hotel",
  "Island Tower at Disney’s Polynesian Villas & Bungalows": "Polynesian Villas"
};

const BROKER_ROOM_TYPE_CODES = {
  "Deluxe Studio": "studio",
  "Tower Studio": "studio",
  "Duo Studio": "studio",
  "1 Bedroom Villa": "onebed",
  "One Bedroom Villa": "onebed",
  "2 Bedroom Villa": "twobed",
  "Two Bedroom Villa": "twobed",
  "3 Bedroom Grand Villa": "threebed",
  "Three Bedroom Grand Villa": "threebed",
  "Bungalow": "threebed",
  "Cabin": "threebed"
};

function roomTypePatterns(roomTypeName) {
  const name = normalize(roomTypeName);

  if (name.includes("duo studio")) return ["duo studio", "studio"];
  if (name.includes("tower studio")) return ["tower studio", "studio"];
  if (name.includes("deluxe studio")) return ["deluxe studio", "studio"];
  if (name.includes("1 bedroom") || name.includes("one bedroom")) {
    return ["1-bedroom villa", "one-bedroom villa", "1 bedroom villa"];
  }
  if (name.includes("2 bedroom") || name.includes("two bedroom")) {
    return ["2-bedroom villa", "two-bedroom villa", "2 bedroom villa"];
  }
  if (name.includes("3 bedroom") || name.includes("three bedroom")) {
    return ["3-bedroom grand villa", "three-bedroom grand villa", "3 bedroom grand villa"];
  }
  if (name.includes("bungalow")) return ["bungalow"];
  if (name.includes("cabin")) return ["cabin"];

  return [name];
}

function buildBrokerUrl(item) {
  const resortLabel = BROKER_RESORT_NAMES[item.resort_name];
  const roomCode = BROKER_ROOM_TYPE_CODES[item.room_type_name] || "studio";

  if (!resortLabel) {
    throw new Error(`No broker resort mapping for "${item.resort_name}"`);
  }

  const params = new URLSearchParams({
    dvc_check_in: item.check_in_date,
    dvc_check_out: item.check_out_date,
    dvc_vacancy: "available",
    dvc_resorts: resortLabel,
    dvc_room_types: roomCode
  });

  return `https://dvc-rental.com/renters/reservation-request/?${params.toString()}`;
}

function extractStatusFromHtml(html, item) {
  const htmlLower = normalize(html);
  const resortNeedle = normalize(BROKER_RESORT_NAMES[item.resort_name] || item.resort_name);
  const patterns = roomTypePatterns(item.room_type_name);

  const hasResort = htmlLower.includes(resortNeedle);
  const hasRoomType = patterns.some((p) => htmlLower.includes(normalize(p)));

  if (!hasResort || !hasRoomType) {
    return "unavailable";
  }

  if (htmlLower.includes("almost gone")) {
    return "limited";
  }

  if (htmlLower.includes("book now")) {
    return "available";
  }

  return "available";
}

// ---------- broker checker ----------

async function checkBroker(item) {
  const url = buildBrokerUrl(item);

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0"
    }
  });

  if (!res.ok) {
    throw new Error(`Broker page returned ${res.status}`);
  }

  const html = await res.text();
  const status = extractStatusFromHtml(html, item);

  return {
    queue_item_id: item.queue_item_id,
    resort_name: item.resort_name,
    room_type_name: item.room_type_name,
    check_in_date: item.check_in_date,
    check_out_date: item.check_out_date,
    nights: item.nights,
    status,
    confidence_score:
      status === "available" ? 0.85 :
      status === "limited" ? 0.75 :
      0.70,
    checked_at: new Date().toISOString(),
    notes: "automatic broker-source check",
    raw_result_json: {
      source_url: url
    }
  };
}

// ---------- main runner ----------

async function runCrawler() {
  console.log("Starting nightly crawl");

  let queue;
  try {
    queue = await getQueue();
  } catch (err) {
    console.error("Failed to fetch queue:", err.message);
    return;
  }

  const items =
    queue?.data?.queue_items ||
    queue?.data?.items ||
    queue?.queue_items ||
    queue?.items ||
    [];

  console.log("Queue response top-level keys:", Object.keys(queue || {}));
  if (queue?.data && typeof queue.data === "object") {
    console.log("Queue response data keys:", Object.keys(queue.data));
  }
  console.log("Items found:", items.length);

  if (items.length === 0) {
    console.log("Nothing to check");
    return;
  }

  for (const item of items) {
    try {
      const result = await checkBroker(item);
      console.log(
        `Checked ${item.resort_name} | ${item.room_type_name} | ${item.check_in_date} -> ${result.status}`
      );
      await sendResult(result);

      // tiny pause so we do not hammer the broker site
      await sleep(250);
    } catch (err) {
      console.error(`Failed queue item ${item.queue_item_id}:`, err.message);
      await markFailed(item.queue_item_id, err.message);
    }
  }

  console.log("Nightly crawl finished");
}

// Run once immediately
runCrawler().catch((err) => {
  console.error("Fatal crawler error:", err.message);
});

// Also keep the 15-minute schedule
cron.schedule("*/15 * * * *", async () => {
  try {
    await runCrawler();
  } catch (err) {
    console.error("Scheduled run failed:", err.message);
  }
});
