var sheetName = "g3n"; // Sesuaikan dengan nama Sheet kamu di bawah (tab bawah)
var ss = SpreadsheetApp.getActiveSpreadsheet();
var sheet = ss.getSheetByName(sheetName);
 
// 1. Menerima Data dari Saweria (doPost)
function doPost(e) {
    try {
    var data = JSON.parse(e.postData.contents);
    
    // Format dari Saweria biasanya: { "donator_name": "Budi", "amount_raw": 10000, "message": "Semangat bang", "id": "trx_123" }
    var id = data.id;
    var donator = data.donator_name;
    var amount = data.amount_raw;
    var message = data.message;
    var date = new Date();
    
    sheet.appendRow([id, donator, amount, message, date]);
    
    return ContentService.createTextOutput(JSON.stringify({"status": "success"}));
    } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({"status": "failed", "error": error.toString()}));
    }
    }
    
    // 2. Mengirim Data ke Roblox (doGet)
    function doGet(e) {
        var rows = sheet.getDataRange().getValues();
        var result = [];
        
        // Loop dari baris ke-2 (melewati header)
        for (var i = 1; i < rows.length; i++) {
            result.push({
            "id": rows[i][0],
            "donator": rows[i][1],
            "amount": rows[i][2],
            "message": rows[i][3]
            });
            }
            
            // Return data sebagai JSON agar bisa dibaca Roblox
            return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
            }
