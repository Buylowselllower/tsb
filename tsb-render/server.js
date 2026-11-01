import express from 'express';
import Database from 'better-sqlite3';
import crypto from 'crypto';

const app = express();

// Enable CORS for all incoming requests (Website A, Puppeteer worker, local dev)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, x-worker-key');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());
app.use(express.static('public'));

const db = new Database('orders.db');
db.exec(`CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, 
  details TEXT, 
  status TEXT DEFAULT 'pending',
  address TEXT, 
  created_at INTEGER, 
  claimed_at INTEGER
)`);

const WORKER_KEY = process.env.WORKER_KEY || 'my_secret_worker_key';

// Worker authentication middleware
const auth = (req, res, next) => {
  const clientKey = req.headers['x-worker-key'];
  if (!WORKER_KEY || clientKey !== WORKER_KEY) {
    return res.status(401).json({ error: 'Unauthorized worker key' });
  }
  next();
};

// 1. User submits Page 1 details on Website A -> Status set to 'pending'
app.post('/api/orders', (req, res) => {
  const id = crypto.randomUUID();
  const detailsStr = typeof req.body.details === 'string' 
    ? req.body.details 
    : JSON.stringify(req.body.details || req.body);

  db.prepare('INSERT INTO orders (id, details, status, created_at) VALUES (?, ?, "pending", ?)')
    .run(id, detailsStr, Date.now());
  res.json({ id });
});

// 2. User submits Page 2 interview slots -> Attaches slots and sets status to 'page2_ready'
app.post('/api/interviews', (req, res) => {
  const { orderId, slots, timezone } = req.body;
  const o = db.prepare('SELECT details FROM orders WHERE id=?').get(orderId);
  if (!o) return res.status(404).json({ error: 'Order not found' });

  let currentDetails = {};
  try {
    currentDetails = JSON.parse(o.details || '{}');
  } catch (e) {
    currentDetails = {};
  }

  const updatedDetails = JSON.stringify({ ...currentDetails, slots, timezone });

  db.prepare(`UPDATE orders SET details=?, status='page2_ready' WHERE id=?`)
    .run(updatedDetails, orderId);

  res.json({ success: true });
});

// 3. Status polling endpoint for Frontend and Puppeteer
app.get('/api/orders/:id', (req, res) => {
  const o = db.prepare('SELECT status, address, details FROM orders WHERE id=?').get(req.params.id);
  if (!o) return res.status(404).json({ status: 'not_found' });

  let parsedDetails = {};
  try {
    parsedDetails = typeof o.details === 'string' ? JSON.parse(o.details) : o.details;
  } catch (e) {
    parsedDetails = {};
  }

  res.json({
    status: o.status,
    address: o.address,
    details: parsedDetails
  });
});

// 4. Puppeteer claims pending Page 1 job
app.post('/api/worker/claim', auth, (req, res) => {
  const o = db.prepare(`SELECT * FROM orders WHERE status='pending' ORDER BY created_at LIMIT 1`).get();
  if (!o) return res.json(null);

  db.prepare(`UPDATE orders SET status='processing_page1', claimed_at=? WHERE id=?`).run(Date.now(), o.id);
  res.json(o);
});

// 5. Puppeteer updates status mid-task (e.g. 'awaiting_page2')
app.post('/api/worker/update-status', auth, (req, res) => {
  const { id, status } = req.body;
  if (!id || !status) return res.status(400).json({ error: 'Missing id or status' });

  db.prepare(`UPDATE orders SET status=? WHERE id=?`).run(status, id);
  res.sendStatus(200);
});

// 6. Puppeteer submits final QR code result
app.post('/api/worker/complete', auth, (req, res) => {
  const { id, address, error } = req.body;
  if (error) {
    db.prepare(`UPDATE orders SET status='failed' WHERE id=?`).run(id);
  } else {
    db.prepare(`UPDATE orders SET status='ready', address=? WHERE id=?`).run(address || 'COMPLETED', id);
  }
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
