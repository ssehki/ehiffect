/**
 * EHIFFECT BOOKING BACKEND
 * ========================
 * This one file powers three things:
 *   1. The booking website  (saves bookings, looks up clients)
 *   2. The "Bookings" sheet (your raw list of every request)
 *   3. Two auto-updating tabs: "Dashboard" and "Clients"
 *
 * SETUP (first time, or after pasting an update)
 *   1. Extensions → Apps Script → delete everything → paste this whole file → Save.
 *   2. Pick "formatSheet" in the function dropdown at the top → Run → approve permissions.
 *   3. Deploy → Manage deployments → pencil icon → Version: New version → Deploy.
 *      (Editing the existing deployment keeps your website URL the same.)
 *   After that, a menu called "Ehiffect" appears in your sheet with a Refresh button.
 *
 * HOW YOUR SHEET WORKS
 *   • Dashboard = overview: what's pending, deal alerts, deal usage. Updates by itself.
 *   • Clients   = one row per person: visits, deals they've used, loyalty countdown.
 *   • Bookings  = every request. Change the Status dropdown and the other tabs refresh.
 *   • Columns are found by their header NAME, so you can insert/move your own columns
 *     in Bookings without breaking anything. ("total" may also be titled "pricing".)
 *
 * NOTE: everything goes through doGet (not doPost) because browsers turn POST into GET when
 * following Apps Script's redirect, so POST from a GitHub Pages site never reliably arrives.
 */


/* ================================================================
   1. SETTINGS — the only part you'll normally want to edit
   ================================================================ */

const NOTIFY_EMAIL = "ehivoltk@gmail.com";           // where new-booking emails go
const PHOTO_FOLDER_NAME = "Ehiffect Booking Photos";  // Drive folder for reference photos

// Every Nth approved visit gets flagged for a surprise loyalty gift.
const LOYALTY_SURPRISE_EVERY = 5;

// Every deal on the website: key -> name shown in your sheet.
const DEAL_NAMES = {
  btc: "Back to Campus",
  hallohair: "Hallohair",
  campuscutie: "Campus Cutie",
  loyalty: "Loyalty Love",
  flash: "Flash Deal"
};

// Deals a client should only use ONCE. If someone books with one of these again,
// the booking gets a "Deal alert" (sheet, email, and website dashboard).
// Add or remove keys from the list above to change which deals count.
const ONE_TIME_DEALS = ["btc", "hallohair"];

// Brand colors used to style the sheet.
const COLORS = {
  pink: "#B85C82", blush: "#F4E1EA", cream: "#F8F3EF", ink: "#171214", muted: "#8C7B7E",
  alertBg: "#F6D9D9", alertText: "#7A2F2F", green: "#DDEBD9", gold: "#F3E4BF", grey: "#ECE7E4"
};


/* ================================================================
   2. COLUMNS — find each column by header name (not position)
   ================================================================ */

// Every field this script reads/writes. Order only matters for a brand-new sheet;
// any field missing from your sheet is added on the far right automatically.
const HEADERS = [
  "id", "name", "phone", "ig", "date", "time", "notes", "serviceLabel", "total", "status",
  "submittedAt", "photoUrls", "dealsUsed", "bookingType", "partnerName", "partnerContact",
  "giftKit", "careKitCost", "visitCount", "loyaltyFlag", "dealKeys", "dealAlert"
];

// Other header names that mean the same thing (ignores case, spaces, punctuation).
const HEADER_ALIASES = {
  total: ["pricing", "price"],
  serviceLabel: ["service"],
  photoUrls: ["photos"],
  dealsUsed: ["deals"]
};

function normHeader(s){ return String(s).toLowerCase().replace(/[^a-z0-9]/g, ""); }

function getSheet(){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName("Bookings");
  if(!sheet){
    sheet = ss.insertSheet("Bookings");
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// Returns { map: field -> 0-based column index, width: columns in use }.
function getColumns(sheet){
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(normHeader);
  const map = {};
  let width = lastCol;
  HEADERS.forEach(field => {
    const names = [normHeader(field)].concat((HEADER_ALIASES[field] || []).map(normHeader));
    let idx = headers.findIndex(h => names.indexOf(h) !== -1);
    if(idx === -1){                       // missing → add it on the right, never overwrite
      width += 1;
      sheet.getRange(1, width).setValue(field);
      headers[width - 1] = normHeader(field);
      idx = width - 1;
    }
    map[field] = idx;
  });
  return { map: map, width: Math.max(width, headers.length) };
}

function colLetter(n){
  let s = "";
  while(n > 0){ const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// Every booking as a simple object, e.g. b.name, b.status, b.dealKeys. b.row = sheet row number.
function readBookings(){
  const sheet = getSheet();
  const cols = getColumns(sheet).map;
  const data = sheet.getDataRange().getValues();
  const out = [];
  for(let i = 1; i < data.length; i++){
    const b = { row: i + 1 };
    HEADERS.forEach(f => { const v = data[i][cols[f]]; b[f] = (v === undefined ? "" : v); });
    b.status = String(b.status).trim();
    if(b.id || b.name || b.phone) out.push(b);
  }
  return out;
}

function setCell(sheet, cols, field, row, value){
  sheet.getRange(row, cols[field] + 1).setValue(value);
}


/* ================================================================
   3. CLIENTS & DEALS — who is who, and who used what
   ================================================================ */

// Same client no matter how the number was typed: "(555) 123-4567" = "5551234567".
function phoneKey(p){ return String(p).replace(/\D/g, "").slice(-10); }

function isActive(b){ return b.status === "pending" || b.status === "approved"; }

// Deal keys on a booking. Older bookings (before deals were tracked by key) are
// worked out from the deal names in their text.
function dealsOf(b){
  const listed = String(b.dealKeys || "").split(",").map(s => s.trim()).filter(Boolean);
  if(listed.length) return listed;
  return Object.keys(DEAL_NAMES).filter(k => String(b.dealsUsed).indexOf(DEAL_NAMES[k]) !== -1);
}

function approvedCount(all, phone, excludeRow){
  const key = phoneKey(phone);
  if(!key) return 0;
  return all.filter(b => b.row !== excludeRow && b.status === "approved" && phoneKey(b.phone) === key).length;
}

// e.g. "Back to Campus already used (approved, 09/12/2026 03:00 PM)"; empty = all clear.
function dealAlertFor(all, phone, dealKeys, excludeRow){
  const key = phoneKey(phone);
  if(!key) return "";
  const alerts = [];
  ONE_TIME_DEALS.forEach(deal => {
    if(dealKeys.indexOf(deal) === -1) return;
    const earlier = all.filter(b => b.row !== excludeRow && phoneKey(b.phone) === key && isActive(b) && dealsOf(b).indexOf(deal) !== -1);
    if(earlier.length){
      const last = earlier[earlier.length - 1];
      alerts.push(DEAL_NAMES[deal] + " already used (" + last.status + ", " + asText(last.submittedAt) + ")");
    }
  });
  return alerts.join(" · ");
}

// Client's visit number if this booking gets approved, and whether it earns a loyalty gift.
function applyApproval(sheet, cols, row){
  const all = readBookings();
  const me = all.find(b => b.row === row);
  if(!me) return;
  const visits = approvedCount(all, me.phone, row) + 1;
  setCell(sheet, cols, "visitCount", row, visits);
  setCell(sheet, cols, "loyaltyFlag", row, visits % LOYALTY_SURPRISE_EVERY === 0);
}


/* ================================================================
   4. SAVING BOOKINGS (called by the website)
   ================================================================ */

function withLock(fn){                    // stops two simultaneous bookings from colliding
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function formatDateStr(d){                // "2026-09-25" -> "09/25/2026" (plain text on purpose)
  const p = String(d || "").split("-");
  return p.length === 3 ? p[1] + "/" + p[2] + "/" + p[0] : (d || "");
}

function formatTimeStr(t){                // "15:46" -> "3:46 PM"
  const p = String(t || "").split(":");
  if(p.length < 2) return t || "";
  let h = parseInt(p[0], 10);
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return h + ":" + p[1] + " " + ampm;
}

function formatTimestamp(ms){
  return Utilities.formatDate(new Date(ms), Session.getScriptTimeZone(), "MM/dd/yyyy hh:mm a");
}

function savePhotos(photos){
  if(!photos || !photos.length) return [];
  const folders = DriveApp.getFoldersByName(PHOTO_FOLDER_NAME);
  const folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(PHOTO_FOLDER_NAME);
  const urls = [];
  photos.forEach((dataUrl, i) => {
    try{
      const comma = dataUrl.indexOf(",");
      const type = dataUrl.substring(0, comma).match(/data:(.*?);base64/)[1];
      const blob = Utilities.newBlob(Utilities.base64Decode(dataUrl.substring(comma + 1)), type, "photo_" + Date.now() + "_" + i + ".jpg");
      const file = folder.createFile(blob);
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      urls.push(file.getUrl());
    }catch(e){ /* skip a bad photo rather than failing the whole booking */ }
  });
  return urls;
}

function handleCreate(body){
  return withLock(() => {
    const sheet = getSheet();
    const cols = getColumns(sheet);
    const all = readBookings();

    const dealKeys = String(body.dealKeys || "").split(",").map(s => s.trim()).filter(Boolean);
    const dealAlert = dealAlertFor(all, body.phone, dealKeys, -1);
    const visitCount = approvedCount(all, body.phone, -1) + 1;        // their Nth visit IF approved
    const loyaltyFlag = visitCount % LOYALTY_SURPRISE_EVERY === 0;
    const photoUrls = savePhotos(body.photos);
    const id = "b_" + Date.now() + "_" + Math.floor(Math.random() * 10000);

    const values = {
      id: id, name: body.name || "", phone: body.phone || "", ig: body.ig || "",
      date: formatDateStr(body.date), time: formatTimeStr(body.time), notes: body.notes || "",
      serviceLabel: body.serviceLabel || "", total: body.total || 0, status: "pending",
      submittedAt: formatTimestamp(Date.now()), photoUrls: photoUrls.join("|"),
      dealsUsed: body.dealsLabel || "", bookingType: body.bookingType || "solo",
      partnerName: body.partnerName || "", partnerContact: body.partnerContact || "",
      giftKit: body.giftKit || "", careKitCost: body.careKitCost || "",
      visitCount: visitCount, loyaltyFlag: loyaltyFlag, dealKeys: dealKeys.join(", "), dealAlert: dealAlert
    };
    const row = new Array(cols.width).fill("");           // each value goes under its own header
    Object.keys(values).forEach(f => { row[cols.map[f]] = values[f]; });
    sheet.appendRow(row);

    sendBookingEmail(body, values, photoUrls);
    refreshViews();
    return { ok: true, key: id };
  });
}

function sendBookingEmail(body, v, photoUrls){
  try{
    MailApp.sendEmail({
      to: NOTIFY_EMAIL,
      subject: (v.dealAlert ? "⚠ DEAL ALERT — " : "") + "New Ehiffect booking request — " + (v.name || "unknown"),
      body:
        (v.dealAlert ? "⚠ DEAL ALERT: " + v.dealAlert + "\n\n" : "") +
        "New booking request!\n\n" +
        "Name: " + v.name + "\nPhone: " + v.phone + "\nIG: " + v.ig + "\n" +
        "Service: " + v.serviceLabel + "\n" +
        (v.dealsUsed ? "Deals: " + v.dealsUsed + "\n" : "") +
        (v.bookingType !== "solo" ? "Booking type: " + v.bookingType + " — partner: " + v.partnerName + " " + v.partnerContact + "\n" : "") +
        (v.giftKit ? "Care kit: " + v.giftKit + "\n" : "") +
        (v.careKitCost ? "Bundle care kit: " + v.careKitCost + "\n" : "") +
        "Total: $" + v.total + "\n" +
        "Preferred date/time: " + v.date + " " + v.time + "\n" +
        "Notes: " + v.notes + "\n" +
        (photoUrls.length ? "Photos:\n" + photoUrls.join("\n") + "\n" : "") +
        (v.loyaltyFlag ? "\n🎉 If approved, this would be visit #" + v.visitCount + " for this client — surprise loyalty gift time!\n" : "") +
        "\nApprove or deny it from your dashboard."
    });
  }catch(err){ /* an email hiccup must never block the booking from saving */ }
}

function handleUpdateStatus(body){
  return withLock(() => {
    const sheet = getSheet();
    const cols = getColumns(sheet).map;
    const target = readBookings().find(b => b.id === body.key);
    if(!target) return { ok: false };
    setCell(sheet, cols, "status", target.row, body.status);
    if(body.status === "approved") applyApproval(sheet, cols, target.row);
    refreshViews();
    return { ok: true };
  });
}


/* ================================================================
   5. WEBSITE API
   ================================================================ */

function json(obj){
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function toWebsiteShape(b){
  return {
    key: b.id, name: b.name, phone: b.phone, ig: b.ig, date: b.date, time: b.time, notes: b.notes,
    serviceLabel: b.serviceLabel, total: b.total, status: b.status, submittedAt: b.submittedAt,
    photos: b.photoUrls ? String(b.photoUrls).split("|") : [], dealsUsed: b.dealsUsed || "",
    bookingType: b.bookingType || "solo", partnerName: b.partnerName || "", partnerContact: b.partnerContact || "",
    giftKit: b.giftKit || "", careKitCost: b.careKitCost || "", visitCount: b.visitCount || 0,
    loyaltyFlag: b.loyaltyFlag || false, dealKeys: b.dealKeys || "", dealAlert: b.dealAlert || ""
  };
}

function doGet(e){
  const action = e.parameter.action;

  if(action === "list") return json({ bookings: readBookings().map(toWebsiteShape) });

  // Privacy-friendly: answers yes/no for ONE phone number, never exposes the client list.
  if(action === "checkVisits"){
    const count = approvedCount(readBookings(), e.parameter.phone || "", -1);
    return json({ approvedCount: count, isFirstTime: count === 0 });
  }

  if(action === "create" || action === "updateStatus"){
    let body;
    try{ body = JSON.parse(e.parameter.payload); }
    catch(err){ return json({ error: "bad payload" }); }
    return json(action === "create" ? handleCreate(body) : handleUpdateStatus(body));
  }

  return json({ error: "unknown action" });
}

// Fallback in case anything ever reaches doPost directly; the website doesn't rely on it.
function doPost(e){
  let body;
  if(e.parameter && e.parameter.payload) body = JSON.parse(e.parameter.payload);
  else if(e.postData && e.postData.contents) body = JSON.parse(e.postData.contents);
  else return json({ error: "no data received" });
  if(body.action === "create") return json(handleCreate(body));
  if(body.action === "updateStatus") return json(handleUpdateStatus(body));
  return json({ error: "unknown action" });
}


/* ================================================================
   6. AUTOMATIC UPDATES & MENU
   ================================================================ */

function onOpen(){
  SpreadsheetApp.getUi().createMenu("Ehiffect")
    .addItem("Refresh dashboard & clients", "refreshViews")
    .addItem("Set up / restyle all sheets", "formatSheet")
    .addToUi();
}

// Changing a Status dropdown in the Bookings tab keeps everything else in sync.
function onEdit(e){
  try{
    const sheet = e.range.getSheet();
    if(sheet.getName() !== "Bookings" || e.range.getRow() < 2) return;
    const cols = getColumns(sheet).map;
    if(e.range.getColumn() !== cols.status + 1) return;
    if(String(e.value).trim() === "approved") applyApproval(sheet, cols, e.range.getRow());
    refreshViews();
  }catch(err){ /* never interrupt your editing */ }
}


/* ================================================================
   7. DASHBOARD & CLIENTS TABS (rebuilt automatically)
   ================================================================ */

function refreshViews(){
  try{
    const all = readBookings();
    const clients = buildClients(all);
    writeClientsSheet(clients);
    writeDashboardSheet(all, clients);
  }catch(err){ console.error("refreshViews failed: " + err); }
}

function getOrCreateSheet(name){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

// Safe text for cells that Sheets may have auto-converted into real dates.
function asText(v){
  if(v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), "MM/dd/yyyy hh:mm a");
  return String(v === undefined || v === null ? "" : v);
}

function dealSummary(bookings){
  const counts = {};
  bookings.filter(isActive).forEach(b => dealsOf(b).forEach(d => counts[d] = (counts[d] || 0) + 1));
  return counts;
}

function buildClients(all){
  const groups = {};
  all.forEach(b => {
    const key = phoneKey(b.phone) || ("name:" + String(b.name).toLowerCase().trim());
    (groups[key] = groups[key] || []).push(b);
  });
  return Object.keys(groups).map(key => {
    const bs = groups[key];
    const last = bs[bs.length - 1];
    const visits = bs.filter(b => b.status === "approved").length;
    const counts = dealSummary(bs);
    const used = Object.keys(counts).map(d => (DEAL_NAMES[d] || d) + (counts[d] > 1 ? " ×" + counts[d] : ""));
    const oneTime = ONE_TIME_DEALS.filter(d => counts[d]).map(d => DEAL_NAMES[d]);
    const ig = bs.map(b => b.ig).filter(Boolean).pop() || "";
    return {
      lastRow: last.row, name: last.name, phone: String(last.phone), ig: ig,
      type: visits === 0 ? "Pending" : visits === 1 ? "New" : visits < LOYALTY_SURPRISE_EVERY ? "Returning" : "Regular",
      visits: visits, bookings: bs.length,
      deals: used.join(", ") || "—", oneTime: oneTime.join(", ") || "—",
      loyalty: visits === 0 ? "—" : visits % LOYALTY_SURPRISE_EVERY === 0 ? "Surprise gift due" : (LOYALTY_SURPRISE_EVERY - visits % LOYALTY_SURPRISE_EVERY) + " to go",
      lastBooking: asText(last.submittedAt)
    };
  }).sort((a, b) => b.lastRow - a.lastRow);
}

function styleHeaderRow(range){
  range.setBackground(COLORS.pink).setFontColor("#FFFFFF").setFontWeight("bold").setFontSize(10)
       .setVerticalAlignment("middle").setHorizontalAlignment("left");
}

function writeClientsSheet(clients){
  const sheet = getOrCreateSheet("Clients");
  const f = sheet.getFilter(); if(f) f.remove();
  sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).breakApart();
  sheet.clear();
  sheet.setHiddenGridlines(true);

  const headers = ["Client", "Phone", "Instagram", "Type", "Visits", "Bookings", "Deals used", "One-time deals used", "Loyalty", "Last booking"];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  styleHeaderRow(sheet.getRange(1, 1, 1, headers.length));
  sheet.setRowHeight(1, 34);
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(1);

  if(clients.length){
    const n = clients.length;
    sheet.getRange(2, 2, n, 1).setNumberFormat("@");
    sheet.getRange(2, 1, n, headers.length).setValues(clients.map(c =>
      [c.name, c.phone, c.ig, c.type, c.visits, c.bookings, c.deals, c.oneTime, c.loyalty, c.lastBooking]));
    const body = sheet.getRange(2, 1, n, headers.length);
    body.setFontSize(10).setVerticalAlignment("middle").setWrap(true)
        .setBackgrounds(clients.map((c, i) => new Array(headers.length).fill(i % 2 ? COLORS.cream : "#FFFFFF")));
    sheet.getRange(2, 5, n, 2).setHorizontalAlignment("center");
    sheet.getRange(2, 1, n, 1).setFontWeight("bold");

    const typeColors = { Pending: COLORS.grey, New: COLORS.blush, Returning: COLORS.green, Regular: COLORS.gold };
    sheet.getRange(2, 4, n, 1).setBackgrounds(clients.map(c => [typeColors[c.type]])).setFontWeight("bold");
    clients.forEach((c, i) => {
      if(c.oneTime !== "—") sheet.getRange(i + 2, 8).setBackground(COLORS.alertBg).setFontColor(COLORS.alertText).setFontWeight("bold");
      if(c.loyalty === "Surprise gift due") sheet.getRange(i + 2, 9).setBackground(COLORS.gold).setFontWeight("bold");
    });
    sheet.getRange(1, 1, n + 1, headers.length).createFilter();
  }
  [170, 120, 130, 90, 60, 75, 220, 190, 130, 150].forEach((w, i) => sheet.setColumnWidth(i + 1, w));
  sheet.setTabColor(COLORS.muted);
}

function writeDashboardSheet(all, clients){
  const sheet = getOrCreateSheet("Dashboard");
  sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).breakApart();
  sheet.clear();
  sheet.setHiddenGridlines(true);
  [140, 150, 250, 170, 250, 110, 80, 28, 170, 90, 100].forEach((w, i) => sheet.setColumnWidth(i + 1, w));

  const pending = all.filter(b => b.status === "pending");
  const approved = all.filter(b => b.status === "approved");
  const value = approved.reduce((sum, b) => sum + (isNaN(Number(b.total)) ? 0 : Number(b.total)), 0);
  const alerts = pending.filter(b => b.dealAlert);
  const returning = clients.filter(c => c.visits >= 2).length;

  // --- header band ---
  sheet.getRange("A1:K1").merge().setValue("Bookings Overview").setBackground(COLORS.ink).setFontColor(COLORS.cream)
       .setFontFamily("Cormorant Garamond").setFontSize(26).setFontWeight("bold").setVerticalAlignment("middle").setHorizontalAlignment("left");
  sheet.getRange("A2:K2").merge()
       .setValue("Updated " + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "MMM d, h:mm a") + "  ·  change a Status in the Bookings tab and this refreshes on its own")
       .setBackground(COLORS.ink).setFontColor(COLORS.pink).setFontSize(10).setHorizontalAlignment("left");
  sheet.setRowHeight(1, 54); sheet.setRowHeight(2, 24); sheet.setRowHeight(3, 14);

  // --- stat tiles (columns A–E) ---
  const tiles = [
    { label: "PENDING",        value: pending.length,   fmt: "0",        cap: "waiting on you" },
    { label: "APPROVED",       value: approved.length,  fmt: "0",        cap: "all time" },
    { label: "APPROVED VALUE", value: value,            fmt: "$#,##0",   cap: "quoted totals, all time" },
    { label: "CLIENTS",        value: clients.length,   fmt: "0",        cap: returning + " returning" },
    { label: "DEAL ALERTS",    value: alerts.length,    fmt: "0",        cap: "pending bookings reusing a one-time deal", alert: alerts.length > 0 }
  ];
  tiles.forEach((t, i) => {
    const col = i + 1;
    const block = sheet.getRange(4, col, 3, 1);
    block.setBackground(t.alert ? COLORS.alertBg : COLORS.cream).setHorizontalAlignment("left").setVerticalAlignment("middle")
         .setBorder(true, true, false, true, false, false, "#FFFFFF", SpreadsheetApp.BorderStyle.SOLID_THICK);
    sheet.getRange(4, col).setValue(t.label).setFontSize(9).setFontWeight("bold").setFontColor(t.alert ? COLORS.alertText : COLORS.muted);
    sheet.getRange(5, col).setValue(t.value).setNumberFormat(t.fmt).setFontFamily("Cormorant Garamond").setFontSize(30)
         .setFontWeight("bold").setFontColor(t.alert ? COLORS.alertText : COLORS.ink);
    sheet.getRange(6, col).setValue(t.cap).setFontSize(9).setFontColor(t.alert ? COLORS.alertText : COLORS.muted).setWrap(true);
    sheet.getRange(4, col, 1, 1).setBorder(true, null, null, null, null, null, COLORS.pink, SpreadsheetApp.BorderStyle.SOLID_THICK);
  });
  sheet.setRowHeight(4, 26); sheet.setRowHeight(5, 50); sheet.setRowHeight(6, 34); sheet.setRowHeight(7, 18);

  // --- section titles ---
  ["A8", "I8"].forEach((a, i) => sheet.getRange(a).setValue(i ? "Deals at a glance" : "Needs your attention")
       .setFontFamily("Cormorant Garamond").setFontSize(18).setFontWeight("bold").setFontColor(COLORS.ink));
  sheet.setRowHeight(8, 34);

  // --- pending list (newest first) ---
  const listHeaders = ["Submitted", "Client", "Service", "Deals", "Deal alert", "Preferred date", "Total"];
  sheet.getRange(9, 1, 1, listHeaders.length).setValues([listHeaders]);
  styleHeaderRow(sheet.getRange(9, 1, 1, listHeaders.length));
  sheet.setRowHeight(9, 28);

  const rows = pending.slice().reverse().slice(0, 30);
  if(rows.length){
    sheet.getRange(10, 1, rows.length, listHeaders.length).setValues(rows.map(b => [
      asText(b.submittedAt), b.name, b.serviceLabel, b.dealsUsed || "—", b.dealAlert || "—",
      (asText(b.date) + " " + asText(b.time)).trim() || "—", isNaN(Number(b.total)) || b.total === "" ? String(b.total) : Number(b.total)
    ]));
    const body = sheet.getRange(10, 1, rows.length, listHeaders.length);
    body.setFontSize(10).setVerticalAlignment("middle").setWrap(true)
        .setBackgrounds(rows.map((b, i) => new Array(listHeaders.length).fill(i % 2 ? COLORS.cream : "#FFFFFF")));
    sheet.getRange(10, 2, rows.length, 1).setFontWeight("bold");
    sheet.getRange(10, 7, rows.length, 1).setNumberFormat("$#,##0").setHorizontalAlignment("right");
    rows.forEach((b, i) => {
      if(b.dealAlert) sheet.getRange(i + 10, 5).setBackground(COLORS.alertBg).setFontColor(COLORS.alertText).setFontWeight("bold");
    });
  }else{
    sheet.getRange(10, 1).setValue("You're all caught up — no pending requests.").setFontColor(COLORS.muted).setFontStyle("italic");
  }

  // --- deals at a glance (columns I–K) ---
  const counts = dealSummary(all);
  const dealHeaders = ["Deal", "Times used", "Type"];
  sheet.getRange(9, 9, 1, 3).setValues([dealHeaders]);
  styleHeaderRow(sheet.getRange(9, 9, 1, 3));
  const dealKeys = Object.keys(DEAL_NAMES);
  sheet.getRange(10, 9, dealKeys.length, 3).setValues(dealKeys.map(k =>
    [DEAL_NAMES[k], counts[k] || 0, ONE_TIME_DEALS.indexOf(k) !== -1 ? "One-time" : "Any time"]));
  sheet.getRange(10, 9, dealKeys.length, 3).setFontSize(10).setVerticalAlignment("middle")
       .setBackgrounds(dealKeys.map((k, i) => new Array(3).fill(i % 2 ? COLORS.cream : "#FFFFFF")));
  sheet.getRange(10, 10, dealKeys.length, 1).setHorizontalAlignment("center");
  dealKeys.forEach((k, i) => {
    if(ONE_TIME_DEALS.indexOf(k) !== -1) sheet.getRange(i + 10, 11).setFontColor(COLORS.alertText).setFontWeight("bold");
  });
  sheet.setTabColor(COLORS.pink);
}


/* ================================================================
   8. ONE-TIME SETUP — restyles the Bookings tab and builds the other two
   ================================================================ */

function formatSheet(){
  formatBookingsSheet();
  refreshViews();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ["Dashboard", "Clients", "Bookings"].forEach((name, i) => {   // order the tabs
    const s = ss.getSheetByName(name);
    if(s){ ss.setActiveSheet(s); ss.moveActiveSheet(i + 1); }
  });
  ss.setActiveSheet(ss.getSheetByName("Dashboard"));
}

function formatBookingsSheet(){
  const sheet = getSheet();
  const cols = getColumns(sheet);
  const c = cols.map;
  const ROWS = 1000;                                   // formats ahead so new rows inherit it

  // A new sheet only has 1000 rows; make room so formatting 1000 rows ahead can't run off the end.
  if(sheet.getMaxRows() < ROWS + 1) sheet.insertRowsAfter(sheet.getMaxRows(), ROWS + 1 - sheet.getMaxRows());
  if(sheet.getMaxColumns() < cols.width) sheet.insertColumnsAfter(sheet.getMaxColumns(), cols.width - sheet.getMaxColumns());

  sheet.setHiddenGridlines(true);
  sheet.setTabColor(COLORS.ink);
  const header = sheet.getRange(1, 1, 1, cols.width);
  header.setBackground(COLORS.pink).setFontColor("#FFFFFF").setFontWeight("bold").setFontSize(10).setVerticalAlignment("middle");
  sheet.setRowHeight(1, 34);
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(c.name + 1);

  const widths = {
    name: 130, phone: 110, ig: 110, date: 90, time: 90, notes: 220, serviceLabel: 260, total: 70, status: 100,
    submittedAt: 150, photoUrls: 260, dealsUsed: 220, bookingType: 100, partnerName: 130, partnerContact: 150,
    giftKit: 220, careKitCost: 150, visitCount: 80, loyaltyFlag: 90, dealKeys: 130, dealAlert: 260
  };
  Object.keys(widths).forEach(f => sheet.setColumnWidth(c[f] + 1, widths[f]));
  sheet.hideColumns(c.id + 1);                         // internal id, you never need to see it

  const data = sheet.getRange(2, 1, ROWS, cols.width);
  data.setFontSize(10).setVerticalAlignment("middle");
  ["notes", "serviceLabel", "photoUrls", "dealsUsed", "giftKit", "dealAlert"].forEach(f =>
    sheet.getRange(2, c[f] + 1, ROWS, 1).setWrap(true));

  // Lock date/time/submittedAt as PLAIN TEXT so Sheets can't turn them into its own date values.
  ["date", "time", "submittedAt"].forEach(f =>
    sheet.getRange(2, c[f] + 1, ROWS, 1).setNumberFormat("@"));

  // soft alternating row colors
  sheet.getBandings().forEach(b => b.remove());
  sheet.getRange(2, 1, ROWS, cols.width).applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, false, false)
       .setFirstRowColor("#FFFFFF").setSecondRowColor(COLORS.cream);

  // filter buttons on the header row
  const filter = sheet.getFilter(); if(filter) filter.remove();
  sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 2), cols.width).createFilter();

  // status dropdown + colors, deal alert highlight, loyalty highlight
  const statusRange = sheet.getRange(2, c.status + 1, ROWS, 1);
  statusRange.setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(["pending", "approved", "denied", "no-show"], true).setAllowInvalid(false).build());

  const rules = [
    { text: "approved", bg: "#C9E3C6", fg: "#2F5C2B" },
    { text: "denied",   bg: "#E9C9C9", fg: "#7A2F2F" },
    { text: "no-show",  bg: "#D6C9F0", fg: "#4A3670" },
    { text: "pending",  bg: "#F5E3B3", fg: "#7A5C14" }
  ].map(r => SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(r.text)
      .setBackground(r.bg).setFontColor(r.fg).setBold(true).setRanges([statusRange]).build());

  const alertRange = sheet.getRange(2, c.dealAlert + 1, ROWS, 1);
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied("=LEN($" + colLetter(c.dealAlert + 1) + "2)>0")
    .setBackground(COLORS.alertBg).setFontColor(COLORS.alertText).setBold(true).setRanges([alertRange]).build());

  const loyaltyRange = sheet.getRange(2, c.loyaltyFlag + 1, ROWS, 1);
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo("TRUE")
    .setBackground(COLORS.gold).setFontColor("#7A5C14").setBold(true).setRanges([loyaltyRange]).build());

  sheet.setConditionalFormatRules(rules);
  SpreadsheetApp.flush();
}

function testEmail(){
  MailApp.sendEmail({ to: NOTIFY_EMAIL, subject: "Test email from Ehiffect script", body: "If you're reading this, email sending works!" });
}
