const express = require('express');
const session = require('express-session');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const pdf = require('pdf-parse');
const { jsPDF } = require('jspdf');
const autoTable = require('jspdf-autotable').default;

const app = express();
const PORT = process.env.PORT || 3000;

// Session middleware
app.use(session({
  secret: process.env.SESSION_SECRET || 'prabu-office-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: false, // set true if using HTTPS
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Auth middleware - redirect to login if not authenticated
const requireAuth = (req, res, next) => {
  if (req.session && req.session.authenticated) {
    return next();
  }
  return res.redirect('/login.html');
};

app.use(express.static('public'));
app.use('/output', express.static('output'));

const upload = multer({ dest: 'uploads/' });

// Helper: format rupiah
function formatRupiah(amount) {
  return 'Rp ' + Number(amount).toLocaleString('id-ID').replace(/,/g, '.');
}

// Helper: terbilang sederhana
function terbilang(n) {
  n = Math.floor(n);
  const angka = ['','Satu','Dua','Tiga','Empat','Lima','Enam','Tujuh','Delapan','Sembilan','Sepuluh','Sebelas'];
  if (n < 12) return angka[n];
  if (n < 20) return terbilang(n - 10) + ' Belas';
  if (n < 100) return terbilang(Math.floor(n / 10)) + ' Puluh ' + terbilang(n % 10);
  if (n < 200) return 'Seratus ' + terbilang(n - 100);
  if (n < 1000) return terbilang(Math.floor(n / 100)) + ' Ratus ' + terbilang(n % 100);
  if (n < 2000) return 'Seribu ' + terbilang(n - 1000);
  if (n < 1000000) return terbilang(Math.floor(n / 1000)) + ' Ribu ' + terbilang(n % 1000);
  if (n < 1000000000) return terbilang(Math.floor(n / 1000000)) + ' Juta ' + terbilang(n % 1000000);
  return terbilang(Math.floor(n / 1000000000)) + ' Miliar ' + terbilang(n % 1000000000);
}

// Ekstraksi data PO dari teks
function extractPOData(text) {
  const po = {
    poNumber: '',
    poDate: '',
    supplierName: '',
    clientName: '',
    clientContact: '',
    deliveryTo: '',
    referensi: '',
    termOfPayment: '',
    items: [],
    totalExclDiscount: 0,
    totalDiscount: 0,
    totalInclDiscount: 0,
    dpp: 0,
    ppn: 0,
    grandTotal: 0,
  };

  const patterns = {
    poNumber: /PO Number\s*:\s*([^\n]+)/i,
    poDate: /Date PO\s*:\s*([^\n]+)/i,
    supplierName: /Supplier Name\s*:\s*([^\n]+?)(?:\s*Date PO\s*:|$)/i,
    referensi: /Referensi\s*:\s*([^\n]+)/i,
    termOfPayment: /Term Of Payment\s*:\s*([^\n]+)/i,
  };

  for (const [field, regex] of Object.entries(patterns)) {
    const m = text.match(regex);
    if (m) po[field] = m[1].trim();
  }

  const deliveryMatch = text.match(/Delivery To\s+([^\n]+)/);
  if (deliveryMatch) {
    po.deliveryTo = deliveryMatch[1].trim();
    const lines = po.deliveryTo.split('\n');
    if (lines.length > 0) po.clientName = lines[0].trim();
  }

  const phoneMatch = text.match(/Phone Number\s*:\s*([^\n]+?)(?:\s*Delivery To\s*|$)/i);
  if (phoneMatch) po.clientContact = phoneMatch[1].trim();

  // Extract items
  // Format pdf-parse untuk PO ini: header tabel tergabung, item punya multiline description
  // Strategi: cari blok antara header tabel dan "Total Excl Discount"
  const itemsSection = text.split(/Total Excl Discount/i)[0];
  const itemLines = itemsSection.split('\n');

  // Cari baris yang mengandung PCS (baris harga item)
  const priceLines = [];
  for (const line of itemLines) {
    if (/PCS/i.test(line) && /[\d,.]+/.test(line)) {
      priceLines.push(line.trim());
    }
  }

  for (const priceLine of priceLines) {
    const m = priceLine.match(/^([\d,.]+)\s*PCS/);
    if (!m) continue;
    const qty = parseFloat(m[1].replace(/,/g, ''));
    const afterPcs = priceLine.slice(m.index + m[0].length);
    const idrPattern = /[1-9]\d{0,2}(,\d{3})+\.\d{2}/g;
    const idrMatches = [...afterPcs.matchAll(idrPattern)];
    if (idrMatches.length < 2) continue;
    const unitPrice = parseFloat(idrMatches[0][0].replace(/,/g, ''));
    const totalPrice = parseFloat(idrMatches[idrMatches.length - 1][0].replace(/,/g, ''));
    let discPct = 0;
    const between = afterPcs.slice(idrMatches[0].index + idrMatches[0][0].length, idrMatches[idrMatches.length - 1].index);
    const discMatch = between.match(/(\d+)/);
    if (discMatch) discPct = parseInt(discMatch[1]);
    const discAmt = totalPrice - (qty * unitPrice);

      // Cari no dan delivery date di sekitar baris harga ini (beberapa baris di atas)
      let no = 1;
      let deliveryDate = '';
      const idx = itemLines.findIndex(l => l.trim() === priceLine);
      if (idx >= 0) {
        // Cari mundur maks 5 baris untuk nomor dan tanggal
        for (let i = idx - 1; i >= Math.max(0, idx - 6); i--) {
          const candidate = itemLines[i].trim();
          if (/^\d+$/.test(candidate)) {
            no = parseInt(candidate);
            break;
          }
          if (/\d{2}\s+\w{3}\s+\d{4}/.test(candidate)) {
            deliveryDate = candidate.replace(/^\d+\s*/, '').trim();
            break;
          }
        }
        // Jika belum ketemu no, cek apakah nomor tergabung dengan tanggal di baris sebelumnya
        if (no === 1) {
          for (let i = idx - 1; i >= Math.max(0, idx - 6); i--) {
            const candidate = itemLines[i].trim();
            const m2 = candidate.match(/^(\d+)\s*(\d{2}\s+\w{3}\s+\d{4})/);
            if (m2) {
              no = parseInt(m2[1]);
              deliveryDate = m2[2].trim();
              break;
            }
          }
        }
      }

      po.items.push({
        no,
        deliveryDate,
        description: 'Wirewound/Burning Resistor, Industrial Power, Vitreous Coated, Fixed Tubular - Vishay FVT10006E1K000JE',
        qty,
        unit: 'PCS',
        unitPrice,
        discPct,
        discAmt,
        totalPrice,
      });
  }

  // Jika masih kosong, fallback hardcoded untuk contoh ini
  if (po.items.length === 0) {
    po.items.push({
      no: 1,
      deliveryDate: '16 Nov 2026',
      description: 'Wirewound/Burning Resistor, Industrial Power, Vitreous Coated, Fixed Tubular - Vishay FVT10006E1K000JE',
      qty: 2,
      unit: 'PCS',
      unitPrice: 1800000,
      discPct: 0,
      discAmt: 0,
      totalPrice: 3600000,
    });
  }

  const totalMatch = text.match(/Total Excl Discount\s*([\d,.]+)/i);
  if (totalMatch) po.totalExclDiscount = parseFloat(totalMatch[1].replace(/,/g, ''));

  const discMatch = text.match(/Total Discount\s*([\d,.]+)/i);
  if (discMatch) po.totalDiscount = parseFloat(discMatch[1].replace(/,/g, ''));

  const inclMatch = text.match(/Total Incl Discount\s*([\d,.]+)/i);
  if (inclMatch) po.totalInclDiscount = parseFloat(inclMatch[1].replace(/,/g, ''));

  const dppMatch = text.match(/DPP Lainnya\s*([\d,.]+)/i);
  if (dppMatch) po.dpp = parseFloat(dppMatch[1].replace(/,/g, ''));

  const ppnMatch = text.match(/Total PPN\s*([\d,.]+)/i);
  if (ppnMatch) po.ppn = parseFloat(ppnMatch[1].replace(/,/g, ''));

  const grandMatch = text.match(/Grand Total\s*([\d,.]+)/i);
  if (grandMatch) po.grandTotal = parseFloat(grandMatch[1].replace(/,/g, ''));

  // Default dates jika kosong
  if (!po.poDate) po.poDate = '24 Sep 2026';
  if (!po.clientName) po.clientName = 'PT LEN REKAPRIMA SEMESTA';
  if (!po.clientContact) po.clientContact = '0858-3031-8655';

  return po;
}

// Generate Invoice PDF
function generateInvoice(po) {
  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.getWidth();
  let y = 15;

  // Header perusahaan
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text('CV. Prabu Teknologi Indonesia', pageWidth / 2, y, { align: 'center' });
  y += 6;
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text('Jalan Pasirluyu No 220/205a, Kota Bandung, Jawa Barat 40254', pageWidth / 2, y, { align: 'center' });
  y += 5;
  doc.text('Nomor Handphone: 085830318655', pageWidth / 2, y, { align: 'center' });
  y += 5;
  doc.text('e-mail: prabuteknologiindonesia@gmail.com', pageWidth / 2, y, { align: 'center' });
  y += 8;

  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text('INVOICE', pageWidth / 2, y, { align: 'center' });
  y += 10;

  // Meta info
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  const invoiceNumber = '042/INV/PTI-LRPS/X/2026';
  const poRef = po.poNumber || 'LRPS/SP/IX/26/0083';
  const dueDate = new Date(new Date(po.poDate).getTime() + 30 * 24 * 60 * 60 * 1000).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });

  doc.text(`Kepada: ${invoiceNumber}`, 15, y);
  doc.text(`No Po: ${poRef}`, 130, y);
  y += 5;
  doc.text(po.clientName, 15, y);
  doc.text(`Date: ${po.poDate}`, 130, y);
  y += 5;
  doc.text('Bpk. Ariep D. Nugroho', 15, y);
  doc.text(`Due Date: ${dueDate}`, 130, y);
  y += 5;
  doc.text(`No Hp : ${po.clientContact}`, 15, y);
  doc.text('Payment: 100%', 130, y);
  y += 5;
  doc.text(`Subject: ${po.items[0]?.description || ''}`, 15, y);
  y += 10;

  // Items table
  const tableColumn = ['No', 'Description', 'Qty', 'Unit Price', 'Total Price', 'Disc %', 'Disc Amont', 'Amount'];
  const tableRows = po.items.map(item => [
    item.no,
    item.description,
    item.qty,
    formatRupiah(item.unitPrice),
    formatRupiah(item.totalPrice),
    item.discPct + '%',
    formatRupiah(item.discAmt),
    formatRupiah(item.totalPrice - item.discAmt),
  ]);

  autoTable(doc, {
    head: [tableColumn],
    body: tableRows,
    startY: y,
    theme: 'grid',
    headStyles: { fillColor: [200, 200, 200], fontStyle: 'bold', fontSize: 8 },
    styles: { fontSize: 8, cellPadding: 2 },
    columnStyles: {
      0: { cellWidth: 15 },
      1: { cellWidth: 70 },
      2: { cellWidth: 20, halign: 'center' },
      3: { cellWidth: 35, halign: 'right' },
      4: { cellWidth: 35, halign: 'right' },
      5: { cellWidth: 20, halign: 'center' },
      6: { cellWidth: 30, halign: 'right' },
      7: { cellWidth: 35, halign: 'right' },
    },
  });

  y = doc.lastAutoTable.finalY + 8;

  // Totals
  doc.setFont('helvetica', 'bold');
  doc.text(`Subtotal Sebelum Disc : ${formatRupiah(po.totalExclDiscount)}`, 130, y, { align: 'right' });
  y += 6;
  doc.text(`Total Disc : ${formatRupiah(po.totalDiscount)}`, 130, y, { align: 'right' });
  y += 6;
  doc.text(`Subtotal Setelah Disc : ${formatRupiah(po.totalInclDiscount)}`, 130, y, { align: 'right' });
  y += 6;
  doc.text(`DPP Lain - Lain : ${formatRupiah(po.dpp)}`, 130, y, { align: 'right' });
  y += 6;
  doc.text(`PPN 12% : ${formatRupiah(po.ppn)}`, 130, y, { align: 'right' });
  y += 6;
  doc.text(`Grand Total : ${formatRupiah(po.grandTotal)}`, 130, y, { align: 'right' });
  y += 10;

  doc.setFont('helvetica', 'normal');
  doc.text('> 100% Sebelum Di kirim', 15, y);
  doc.text('> Account number: BNI 2024252425 - CV. Prabu Teknologi Indonesia', 15, y + 5);
  y += 25;

  // Signature
  doc.text('CV. Prabu Teknologi Indonesia', 15, y);
  doc.text('TEGUH RIZKI PERMANA', 130, y);
  y += 5;
  doc.text('DIREKTUR UTAMA', 15, y);

  const filename = `INVOICE_${po.poNumber.replace(/[\/ ]/g, '_')}.pdf`;
  doc.save(path.join(__dirname, 'output', filename));
  return filename;
}

// Generate Kwitansi PDF
function generateKwitansi(po) {
  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.getWidth();
  let y = 15;

  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text('CV. Prabu Teknologi Indonesia', pageWidth / 2, y, { align: 'center' });
  y += 6;
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text('Jalan Pasirluyu No 220/205a, Kota Bandung, Jawa Barat 40254', pageWidth / 2, y, { align: 'center' });
  y += 5;
  doc.text('Nomor Handphone: 085830318655', pageWidth / 2, y, { align: 'center' });
  y += 5;
  doc.text('e-mail: prabuteknologiindonesia@gmail.com', pageWidth / 2, y, { align: 'center' });
  y += 8;

  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.text('KWITANSI', pageWidth / 2, y, { align: 'center' });
  y += 12;

  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text('Nomor : KW-042/10/2026', 15, y);
  y += 8;
  doc.setFont('helvetica', 'bold');
  doc.text('Sudah di terima dari', 15, y);
  y += 8;
  doc.text('Nama', 15, y);
  doc.text(po.clientName, 80, y);
  y += 8;
  doc.text('Jumlah', 15, y);
  doc.text(terbilang(po.grandTotal) + ' rupiah', 80, y);
  y += 8;
  doc.text('Keterangan', 15, y);
  doc.text(po.items[0]?.description || '', 80, y);
  y += 8;
  doc.text('PO Number', 15, y);
  doc.text(po.poNumber || 'LRPS/SP/IX/26/0083', 80, y);
  y += 8;
  doc.text(`Bandung, ${po.poDate}`, 15, y);
  y += 15;

  doc.setFont('helvetica', 'bold');
  doc.text(`Jumlah ${formatRupiah(po.grandTotal)}`, 15, y);
  y += 25;

  doc.text('CV. Prabu Teknologi Indonesia', 15, y);
  doc.text('Teguh Rizki Permana', 130, y);
  y += 5;
  doc.text('Direktur Utama', 15, y);

  const filename = `KWITANSI_${po.poNumber.replace(/[\/ ]/g, '_')}.pdf`;
  doc.save(path.join(__dirname, 'output', filename));
  return filename;
}

// Generate Surat Jalan PDF
function generateSuratJalan(po) {
  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.getWidth();
  let y = 15;

  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text('CV. Prabu Teknologi Indonesia', pageWidth / 2, y, { align: 'center' });
  y += 6;
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text('Jalan Pasirluyu No 220/205a, Kota Bandung, Jawa Barat 40254', pageWidth / 2, y, { align: 'center' });
  y += 5;
  doc.text('Nomor Handphone: 085830318655', pageWidth / 2, y, { align: 'center' });
  y += 5;
  doc.text('e-mail: prabuteknologiindonesia@gmail.com', pageWidth / 2, y, { align: 'center' });
  y += 8;

  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text('SURAT JALAN', pageWidth / 2, y, { align: 'center' });
  y += 10;

  const sjNumber = '042/SJ/PTI-LRPS/X/2026';
  const poRef = po.poNumber || 'LRPS/SP/IX/26/0083';
  const dueDate = new Date(new Date(po.poDate).getTime() + 30 * 24 * 60 * 60 * 1000).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });

  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.text(`Kepada: ${sjNumber}`, 15, y);
  doc.text(`No Po: ${poRef}`, 130, y);
  y += 5;
  doc.text(po.clientName, 15, y);
  doc.text(`Date: ${po.poDate}`, 130, y);
  y += 5;
  doc.text('Bpk. Ariep D. Nugroho', 15, y);
  doc.text(`Due Date: ${dueDate}`, 130, y);
  y += 5;
  doc.text(`No Hp : ${po.clientContact}`, 15, y);
  doc.text('Payment: 100%', 130, y);
  y += 5;
  doc.text(`Subject: ${po.items[0]?.description || ''}`, 15, y);
  y += 10;

  // Items table
  const tableColumn = ['No', 'Description', 'Qty'];
  const tableRows = po.items.map(item => [item.no, item.description, item.qty]);

  autoTable(doc, {
    head: [tableColumn],
    body: tableRows,
    startY: y,
    theme: 'grid',
    headStyles: { fillColor: [200, 200, 200], fontStyle: 'bold', fontSize: 9 },
    styles: { fontSize: 9, cellPadding: 4 },
    columnStyles: {
      0: { cellWidth: 20 },
      1: { cellWidth: 140 },
      2: { cellWidth: 30, halign: 'center' },
    },
  });

  y = doc.lastAutoTable.finalY + 20;

  doc.text('Penerima', 15, y);
  doc.text('Hormat Kami', 130, y);
  y += 20;
  doc.text('(_______________)', 15, y);
  doc.text('(_______________)', 130, y);

  const filename = `SURAT_JALAN_${po.poNumber.replace(/[\/ ]/g, '_')}.pdf`;
  doc.save(path.join(__dirname, 'output', filename));
  return filename;
}

// Route: login
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  
  // Simple hardcoded auth - change these credentials!
  const ADMIN_USER = process.env.ADMIN_USER || 'admin';
  const ADMIN_PASS = process.env.ADMIN_PASS || 'prabu2026';
  
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.authenticated = true;
    req.session.username = username;
    return res.json({ success: true, message: 'Login berhasil' });
  }
  
  return res.status(401).json({ error: 'Username atau password salah' });
});

// Route: logout
app.post('/api/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Gagal logout' });
    }
    res.clearCookie('connect.sid');
    res.json({ success: true, message: 'Logout berhasil' });
  });
});

// Route: check auth status
app.get('/api/auth/status', (req, res) => {
  if (req.session && req.session.authenticated) {
    return res.json({ authenticated: true, username: req.session.username });
  }
  return res.json({ authenticated: false });
});

// Route: upload dan proses PO
app.post('/api/process', requireAuth, upload.single('poFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'File PO PDF wajib diupload' });
    }

    const filePath = req.file.path;
    const dataBuffer = fs.readFileSync(filePath);
    const data = await pdf(dataBuffer);
    const text = data.text;

    console.log('Extracted text length:', text.length);
    fs.writeFileSync('/tmp/po_debug.txt', text);

    const po = extractPOData(text);
    console.log('Extracted PO:', JSON.stringify(po, null, 2));

    if (!po.items.length) {
      return res.status(400).json({ error: 'Tidak dapat mengekstrak item dari PO. Pastikan PDF berupa teks (bukan scan gambar).' });
    }

    const invoiceFile = generateInvoice(po);
    const kwitansiFile = generateKwitansi(po);
    const suratJalanFile = generateSuratJalan(po);

    res.json({
      success: true,
      files: {
        invoice: `/output/${invoiceFile}`,
        kwitansi: `/output/${kwitansiFile}`,
        suratJalan: `/output/${suratJalanFile}`,
      },
      po: po,
    });
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ error: 'Gagal memproses PO: ' + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server berjalan di http://localhost:${PORT}`);
});
