const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

/* ===== Load airports ===== */

const airports = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "data", "airports.json"),
    "utf8"
  )
);

/* ===== Config ===== */

const TP_TOKEN = process.env.TRAVELPAYOUTS_TOKEN || "";
const MARKER = process.env.TRAVELPAYOUTS_MARKER || "493900";
const SERP_KEY = process.env.SERPAPI_KEY || "";

const hasTP = () => TP_TOKEN.length > 10;
const hasSerp = () => SERP_KEY.length > 10;

/* Major hubs for fallback */
const HUBS = ["LON","AMS","DUB","BRU","CDG","FRA","MAD","STN","LGW"];

/* ===== Health ===== */

app.get("/health", (req,res)=>{
  res.json({
    ok:true,
    travelpayouts: hasTP(),
    serpapi: hasSerp()
  });
});

/* ===== Airport Search ===== */

app.get("/api/places",(req,res)=>{
  const q=(req.query.q||"").toLowerCase();
  if(q.length<2) return res.json([]);

  res.json(
    airports
      .filter(a=>
        a.code.toLowerCase().includes(q) ||
        a.city.toLowerCase().includes(q) ||
        a.name.toLowerCase().includes(q)
      )
      .slice(0,10)
  );
});

/* ===== Travelpayouts Search ===== */

async function searchTP(from,to,date,flex){

  const url=new URL(
    "https://api.travelpayouts.com/aviasales/v3/prices_for_dates"
  );

  url.searchParams.set("origin",from);
  url.searchParams.set("destination",to);
  url.searchParams.set("currency","gbp");
  url.searchParams.set("market","gb");
  url.searchParams.set("limit","30");
  url.searchParams.set("token",TP_TOKEN);

  if(date) url.searchParams.set("departure_at",date);

  if(flex) url.searchParams.set("flexible",flex);

  const r=await fetch(url);
  const j=await r.json();

  if(!Array.isArray(j.data)) return [];

  return j.data.map(x=>({
    from,
    to,
    date:x.depart_date,
    airline:x.airline,
    price:x.price,
    provider:"TP",
    link:
      "https://www.aviasales.com"+
      x.link+
      "?marker="+MARKER
  }));
}

/* ===== SerpAPI Search ===== */

async function searchSerp(from,to,date){

  const url=new URL("https://serpapi.com/search.json");

  url.searchParams.set("engine","google_flights");
  url.searchParams.set("departure_id",from);
  url.searchParams.set("arrival_id",to);
  url.searchParams.set("type","2");
  if(date) url.searchParams.set("outbound_date",date);
  url.searchParams.set("api_key",SERP_KEY);

  const r=await fetch(url);
  const j=await r.json();

  if(!Array.isArray(j.best_flights)) return [];

  return j.best_flights.map(f=>({
    from,
    to,
    date,
    airline: f.flights[0].airline,
    price: f.price,
    provider:"GOOGLE",
    link: f.link
  }));
}

/* ===== Hub Fallback ===== */

async function tryViaHubs(from,to,date,flex){

  let all=[];

  for(const hub of HUBS){

    if(hub===from || hub===to) continue;

    const leg1 = await searchTP(from,hub,date,flex);
    const leg2 = await searchTP(hub,to,null,null);

    leg1.slice(0,3).forEach(a=>{
      leg2.slice(0,3).forEach(b=>{
        all.push({
          from,
          to,
          via:hub,
          price: a.price + b.price,
          legs:[a,b]
        });
      });
    });
  }

  return all.sort((a,b)=>a.price-b.price).slice(0,5);
}

/* ===== Main Search ===== */

app.post("/api/search", async (req,res)=>{

  try{

    const { from,to,date,flex } = req.body;

    if(!from || !to){
      return res.status(400).json({error:"from/to required"});
    }

    let results=[];

    /* 1. Try Travelpayouts */
    if(hasTP()){
      results = await searchTP(from,to,date,flex);
    }

    /* 2. Try hubs */
    let via=[];

    if(results.length===0 && hasTP()){
      via = await tryViaHubs(from,to,date,flex);
    }

    /* 3. Try Google */
    if(results.length===0 && hasSerp()){
      results = await searchSerp(from,to,date);
    }

    res.json({
      direct: results.slice(0,10),
      via,
      meta:{
        usedTP:hasTP(),
        usedSerp:hasSerp()
      }
    });

  }catch(e){
    console.error(e);
    res.status(500).json({error:"search failed"});
  }
});

/* ===== Server ===== */

const port = process.env.PORT || 3000;

app.listen(port,()=>{
  console.log("Atajo running on",port);
});