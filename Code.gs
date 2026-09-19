/**
 * EHIFFECT BOOKING BACKEND
 * ------------------------
 * 1. Go to sheets.google.com → create a new blank Sheet. Name it "Ehiffect Bookings".
 * 2. Extensions → Apps Script. Delete the placeholder code and paste this whole file in.
 * 3. Change NOTIFY_EMAIL below to your real email (the one your phone's Gmail app is signed into).
 * 4. Click Deploy → New deployment → gear icon → "Web app".
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 5. Click Deploy, authorize when Google asks (click Advanced → Go to project (unsafe) — this is
 *    just Google being cautious about your own script, it's fine).
 * 6. Copy the Web App URL it gives you — that's what goes into CONFIG.apiUrl in index.html.
 * 7. Run formatSheet() once (see its own instructions below).
 *
 * COLUMNS ARE FOUND BY HEADER NAME, NOT POSITION. That means you can insert, move, or add your
 * own columns to the Bookings sheet freely and bookings will still land under the right header.
 * (The "total" column may be titled "total" or "pricing".) Any column the script needs that is
 * missing gets added at the far right automatically.
 *
 * NOTE: everything runs through doGet (not doPost). Apps Script's /exec endpoint does an
 * internal redirect, and browsers silently convert POST -> GET when following that redirect —
 * so POST from an external site like GitHub Pages never reliably reaches doPost. GET survives
 * the redirect correctly every time, so all actions (list/create/updateStatus/checkVisits) go
 * through it.
 */

const NOTIFY_EMAIL = "ehivoltk@gmail.com"; // <-- CHANGE THIS
const PHOTO_FOLDER_NAME = "Ehiffect Booking Photos";

// Every Nth approved visit from the same phone number gets flagged for a surprise
// internal loyalty gift. Change this one number any time — nothing else to touch.
const LOYALTY_SURPRISE_EVERY = 5;

// The fields the script reads/writes. Order only matters when a brand-new sheet is created.
const HEADERS = [
  "id","name","phone","ig","date","time","notes","serviceLabel","total","status","submittedAt","photoUrls","dealsUsed",
  "bookingType","partnerName","partnerContact","giftKit","careKitCost","visitCount","loyaltyFlag"
];

// Other header names that count as the same field (compared ignoring case/spaces/punctuation).
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

// Returns { map: field -> 0-based column index, width: number of columns in use }.
// Adds any missing field's header to the far right instead of overwriting anything.
function getColumns(sheet){
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(normHeader);
  const map = {};
  let width = lastCol;
  HEADERS.forEach(field => {
    const names = [normHeader(field)].concat((HEADER_ALIASES[field] || []).map(normHeader));
    let idx = -1;
    for(let i=0; i<headers.length; i++){ if(names.indexOf(headers[i]) !== -1){ idx = i; break; } }
    if(idx === -1){
      width += 1;
      sheet.getRange(1, width).setValue(field);
      headers[width - 1] = normHeader(field);
      idx = width - 1;
    }
    map[field] = idx;
  });
  return { map: map, width: Math.max(width, headers.length) };
}

function getPhotoFolder(){
  const folders = DriveApp.getFoldersByName(PHOTO_FOLDER_NAME);
  if(folders.hasNext()) return folders.next();
  return DriveApp.createFolder(PHOTO_FOLDER_NAME);
}

function savePhotos(photosArray){
  if(!photosArray || !photosArray.length) return [];
  const folder = getPhotoFolder();
  const urls = [];
  photosArray.forEach((dataUrl, i) => {
    try{
      const commaIdx = dataUrl.indexOf(',');
      const meta = dataUrl.substring(0, commaIdx);
      const base64 = dataUrl.substring(commaIdx + 1);
      const contentType = meta.match(/data:(.*?);base64/)[1];
      const blob = Utilities.newBlob(Utilities.base64Decode(base64), contentType, "photo_" + Date.now() + "_" + i + ".jpg");
      const file = folder.createFile(blob);
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      urls.push(file.getUrl());
    }catch(e){ /* skip a bad photo rather than failing the whole booking */ }
  });
  return urls;
}

// Turns "2026-09-25" into "09/25/2026". Plain text, on purpose — see formatSheet().
function formatDateStr(dateStr){
  if(!dateStr) return "";
  const parts = String(dateStr).split("-");
  if(parts.length !== 3) return dateStr;
  return parts[1] + "/" + parts[2] + "/" + parts[0];
}

// Turns "15:46" into "3:46 PM". Plain text, on purpose — see formatSheet().
function formatTimeStr(timeStr){
  if(!timeStr) return "";
  const parts = String(timeStr).split(":");
  if(parts.length < 2) return timeStr;
  let h = parseInt(parts[0], 10);
  const m = parts[1];
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12; if(h === 0) h = 12;
  return h + ":" + m + " " + ampm;
}

// Human-readable "submitted at" stamp, written as plain text so Sheets never
// reinterprets it (that reinterpretation — auto date-detection plus a timezone
// shift — is exactly what produced the giant confusing number before).
function formatTimestamp(ms){
  return Utilities.formatDate(new Date(ms), Session.getScriptTimeZone(), "MM/dd/yyyy hh:mm a");
}

// Counts approved bookings for a phone number, for internal visit tracking.
// excludeRowIndex is a 0-based index into getDataRange().getValues() (header
// row included) to skip — used when recomputing a row's own count so it
// doesn't count itself. Pass -1 to not exclude anything.
function countApprovedForPhone(phone, excludeRowIndex){
  if(!phone) return 0;
  const sheet = getSheet();
  const cols = getColumns(sheet).map;
  const data = sheet.getDataRange().getValues();
  let count = 0;
  for(let i=1; i<data.length; i++){
    if(i === excludeRowIndex) continue;
    if(String(data[i][cols.phone]) === String(phone) && String(data[i][cols.status]).trim() === "approved") count++;
  }
  return count;
}

function handleCreate(body){
  const sheet = getSheet();
  const cols = getColumns(sheet);
  const id = "b_" + new Date().getTime() + "_" + Math.floor(Math.random()*10000);
  const photoUrls = savePhotos(body.photos);
  const niceDate = formatDateStr(body.date);
  const niceTime = formatTimeStr(body.time);
  const niceSubmittedAt = formatTimestamp(new Date().getTime());

  // Internal-only tracking — not sent back to the client, just for your dashboard.
  // This is an estimate at submission time (their Nth visit IF this one gets approved);
  // handleUpdateStatus recomputes it for real when a booking is actually approved,
  // in case bookings get approved out of chronological order.
  const visitCount = countApprovedForPhone(body.phone, -1) + 1;
  const loyaltyFlag = (visitCount % LOYALTY_SURPRISE_EVERY === 0);

  const values = {
    id: id, name: body.name || "", phone: body.phone || "", ig: body.ig || "",
    date: niceDate, time: niceTime, notes: body.notes || "",
    serviceLabel: body.serviceLabel || "", total: body.total || 0, status: "pending",
    submittedAt: niceSubmittedAt, photoUrls: photoUrls.join("|"), dealsUsed: body.dealsLabel || "",
    bookingType: body.bookingType || "solo", partnerName: body.partnerName || "",
    partnerContact: body.partnerContact || "", giftKit: body.giftKit || "",
    careKitCost: body.careKitCost || "", visitCount: visitCount, loyaltyFlag: loyaltyFlag
  };
  // Place every value under its own header, wherever that header currently lives.
  const row = new Array(cols.width).fill("");
  Object.keys(values).forEach(field => { row[cols.map[field]] = values[field]; });
  sheet.appendRow(row);

  try{
    MailApp.sendEmail({
      to: NOTIFY_EMAIL,
      subject: "New Ehiffect booking request — " + (body.name || "unknown"),
      body:
        "New booking request!\n\n" +
        "Name: " + (body.name||"") + "\n" +
        "Phone: " + (body.phone||"") + "\n" +
        "IG: " + (body.ig||"") + "\n" +
        "Service: " + (body.serviceLabel||"") + "\n" +
        (body.dealsLabel ? "Deals: " + body.dealsLabel + "\n" : "") +
        (body.bookingType && body.bookingType !== "solo" ? "Booking type: " + body.bookingType + " — partner: " + (body.partnerName||"") + " " + (body.partnerContact||"") + "\n" : "") +
        (body.giftKit ? "Care kit: " + body.giftKit + "\n" : "") +
        (body.careKitCost ? "Bundle care kit: " + body.careKitCost + "\n" : "") +
        "Total: $" + (body.total||0) + "\n" +
        "Preferred date/time: " + niceDate + " " + niceTime + "\n" +
        "Notes: " + (body.notes||"") + "\n" +
        (photoUrls.length ? "Photos:\n" + photoUrls.join("\n") + "\n" : "") +
        (loyaltyFlag ? "\n🎉 If approved, this would be visit #" + visitCount + " for this client — surprise loyalty gift time!\n" : "") +
        "\nApprove or deny it from your dashboard."
    });
  }catch(err){ /* email failure shouldn't block the booking from saving */ }

  return { ok:true, key:id };
}

function handleUpdateStatus(body){
  const sheet = getSheet();
  const cols = getColumns(sheet).map;
  const data = sheet.getDataRange().getValues();
  for(let i=1; i<data.length; i++){
    if(data[i][cols.id] === body.key){
      sheet.getRange(i+1, cols.status + 1).setValue(body.status);
      if(body.status === "approved"){
        const phone = data[i][cols.phone];
        const visitCount = countApprovedForPhone(phone, i) + 1;
        const loyaltyFlag = (visitCount % LOYALTY_SURPRISE_EVERY === 0);
        sheet.getRange(i+1, cols.visitCount + 1).setValue(visitCount);
        sheet.getRange(i+1, cols.loyaltyFlag + 1).setValue(loyaltyFlag);
      }
      break;
    }
  }
  return { ok:true };
}

function doGet(e){
  const action = e.parameter.action;

  if(action === "list"){
    const sheet = getSheet();
    const cols = getColumns(sheet).map;
    const data = sheet.getDataRange().getValues();
    const rows = data.slice(1); // skip header
    const cell = (r, field) => (r[cols[field]] === undefined ? "" : r[cols[field]]);
    const bookings = rows.map(r => ({
      key: cell(r,"id"), name: cell(r,"name"), phone: cell(r,"phone"), ig: cell(r,"ig"),
      date: cell(r,"date"), time: cell(r,"time"), notes: cell(r,"notes"),
      serviceLabel: cell(r,"serviceLabel"), total: cell(r,"total"), status: cell(r,"status"),
      submittedAt: cell(r,"submittedAt"),
      photos: cell(r,"photoUrls") ? String(cell(r,"photoUrls")).split("|") : [],
      dealsUsed: cell(r,"dealsUsed") || "",
      bookingType: cell(r,"bookingType") || "solo", partnerName: cell(r,"partnerName") || "",
      partnerContact: cell(r,"partnerContact") || "", giftKit: cell(r,"giftKit") || "",
      careKitCost: cell(r,"careKitCost") || "", visitCount: cell(r,"visitCount") || 0,
      loyaltyFlag: cell(r,"loyaltyFlag") || false
    }));
    return ContentService.createTextOutput(JSON.stringify({ bookings }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // Lightweight, privacy-conscious lookup for the public booking page: returns
  // only a count/boolean for ONE phone number, not the rest of the client list.
  if(action === "checkVisits"){
    const phone = e.parameter.phone || "";
    const count = countApprovedForPhone(phone, -1);
    return ContentService.createTextOutput(JSON.stringify({ approvedCount: count, isFirstTime: count === 0 }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  if(action === "create" || action === "updateStatus"){
    let body;
    try{ body = JSON.parse(e.parameter.payload); }
    catch(err){ return ContentService.createTextOutput(JSON.stringify({ error:"bad payload" })).setMimeType(ContentService.MimeType.JSON); }

    const result = action === "create" ? handleCreate(body) : handleUpdateStatus(body);
    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  }

  return ContentService.createTextOutput(JSON.stringify({ error: "unknown action" }))
    .setMimeType(ContentService.MimeType.JSON);
}

// kept as a fallback in case anything ever does reach doPost directly —
// not relied on by the website anymore, but harmless to leave in place.
function doPost(e){
  let body;
  if(e.parameter && e.parameter.payload){ body = JSON.parse(e.parameter.payload); }
  else if(e.postData && e.postData.contents){ body = JSON.parse(e.postData.contents); }
  else { return ContentService.createTextOutput(JSON.stringify({ error:"no data received" })).setMimeType(ContentService.MimeType.JSON); }

  if(body.action === "create") return ContentService.createTextOutput(JSON.stringify(handleCreate(body))).setMimeType(ContentService.MimeType.JSON);
  if(body.action === "updateStatus") return ContentService.createTextOutput(JSON.stringify(handleUpdateStatus(body))).setMimeType(ContentService.MimeType.JSON);
  return ContentService.createTextOutput(JSON.stringify({ error: "unknown action" })).setMimeType(ContentService.MimeType.JSON);
}

/**
 * ONE-TIME SETUP — makes the sheet actually pleasant to use.
 * Run this once: open this file in the Apps Script editor, pick
 * "formatSheet" from the function dropdown at the top (next to Debug),
 * click Run, and approve any permission prompt. Safe to run again anytime.
 * Works off header names, so it formats the right columns even if you've
 * inserted or moved some. It never touches columns it doesn't know about.
 */
function formatSheet(){
  const sheet = getSheet();
  const cols = getColumns(sheet);
  const c = cols.map;
  const FUTURE_PROOF_ROWS = 1000; // formats this many rows ahead so new bookings inherit it automatically

  // header styling (whole header row, including any columns you added yourself)
  const header = sheet.getRange(1, 1, 1, cols.width);
  header.setBackground("#B85C82").setFontColor("#FFFFFF").setFontWeight("bold").setFontSize(11);
  sheet.setFrozenRows(1);
  sheet.setRowHeight(1, 32);

  // column widths, by field
  const widths = {
    name:130, phone:110, ig:110, date:90, time:90, notes:220, serviceLabel:260, total:70, status:100,
    submittedAt:150, photoUrls:260, dealsUsed:220, bookingType:100, partnerName:130, partnerContact:150,
    giftKit:220, careKitCost:150, visitCount:80, loyaltyFlag:90
  };
  Object.keys(widths).forEach(f => sheet.setColumnWidth(c[f] + 1, widths[f]));
  sheet.hideColumns(c.id + 1); // hide the internal id column, you don't need to see it

  // wrap long text columns — applied ahead of current data too
  ["notes","serviceLabel","photoUrls","dealsUsed","giftKit"].forEach(f => {
    sheet.getRange(2, c[f] + 1, FUTURE_PROOF_ROWS, 1).setWrap(true);
  });

  // Lock date, time, and submittedAt as PLAIN TEXT — applied to future rows too.
  // Google Sheets otherwise auto-detects text that looks like a date or time and silently
  // converts it into its own date/time serial value (with a timezone shift).
  ["date","time","submittedAt"].forEach(f => {
    sheet.getRange(2, c[f] + 1, FUTURE_PROOF_ROWS, 1).setNumberFormat("@");
  });

  // dropdown on the status column
  const statusRange = sheet.getRange(2, c.status + 1, FUTURE_PROOF_ROWS, 1);
  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(["pending", "approved", "denied", "no-show"], true)
    .setAllowInvalid(false)
    .build();
  statusRange.setDataValidation(rule);

  // color-code status automatically
  sheet.clearConditionalFormatRules();
  const rules = [
    { text: "approved", bg: "#C9E3C6", fg: "#2F5C2B" },
    { text: "denied",   bg: "#E9C9C9", fg: "#7A2F2F" },
    { text: "no-show",  bg: "#D6C9F0", fg: "#4A3670" },
    { text: "pending",  bg: "#F5E3B3", fg: "#7A5C14" },
  ].map(r =>
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo(r.text)
      .setBackground(r.bg).setFontColor(r.fg).setBold(true)
      .setRanges([statusRange])
      .build()
  );

  // highlight the loyaltyFlag column when TRUE, as a visual heads-up
  const loyaltyRange = sheet.getRange(2, c.loyaltyFlag + 1, FUTURE_PROOF_ROWS, 1);
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo("TRUE")
      .setBackground("#F0D9A8").setFontColor("#7A5C14").setBold(true)
      .setRanges([loyaltyRange])
      .build()
  );
  sheet.setConditionalFormatRules(rules);

  SpreadsheetApp.flush();
}

function testEmail(){
  MailApp.sendEmail({
    to: NOTIFY_EMAIL,
    subject: "Test email from Ehiffect script",
    body: "If you're reading this, email sending works!"
  });
}
