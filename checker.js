import cron from "node-cron";

const EXPORT_URL = "https://dvc365.base44.app/functions/exportAvailabilityCheckQueue";
const INGEST_URL = "https://dvc365.base44.app/functions/ingestAvailabilityCheck";

const QUEUE_SECRET = "93a405ee8da16cf5aacd7d401ccdb9c572bad112eb679482e33d6d3a5ccb5422";
const INGEST_SECRET = "ed10dcbc76950eb78d0317125a67828ad0f1a16757d15e9ff076e4a268887fa7";

const PROVIDER = "official-dvc-checker";

async function getQueue() {

  const res = await fetch(EXPORT_URL,{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({
      secret:QUEUE_SECRET,
      provider_slug:PROVIDER
    })
  });

  return await res.json();
}

async function sendResult(result){

  await fetch(INGEST_URL,{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({
      secret:INGEST_SECRET,
      provider_slug:PROVIDER,
      results:[result]
    })
  });

}

async function checkBroker(item){

  const url =
`https://dvc-rental.com/renters/reservation-request/?dvc_check_in=${item.check_in_date}&dvc_check_out=${item.check_out_date}&dvc_vacancy=available`;

  const res = await fetch(url,{
    headers:{
      "User-Agent":"Mozilla/5.0"
    }
  });

  const html = await res.text();

  let status="unavailable";

  if(html.toLowerCase().includes(item.resort_name.toLowerCase())){
    status="available";
  }

  return {
    queue_item_id:item.queue_item_id,
    resort_name:item.resort_name,
    room_type_name:item.room_type_name,
    check_in_date:item.check_in_date,
    check_out_date:item.check_out_date,
    nights:item.nights,
    status:status,
    confidence_score:0.8,
    checked_at:new Date().toISOString(),
    notes:"nightly broker crawl",
    raw_result_json:{}
  };

}

async function runCrawler(){

  console.log("Starting nightly crawl");

  const queue=await getQueue();

  if(!queue.queue_items || queue.queue_items.length===0){
    console.log("Nothing to check");
    return;
  }

  for(const item of queue.queue_items){

    try{

      const result=await checkBroker(item);

      console.log("Checked",item.resort_name,item.check_in_date);

      await sendResult(result);

    }catch(e){

      console.log("Error",e.message);

    }

  }

}

cron.schedule("0 3 * * *", runCrawler);

runCrawler();
