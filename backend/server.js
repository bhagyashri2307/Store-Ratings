require('dotenv').config();
const express = require('express'), cors = require('cors');
const bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST, user: process.env.DB_USER,
  password: process.env.DB_PASS, database: process.env.DB_NAME,
});
const q = (sql, p) => pool.query(sql, p).then(([rows]) => rows); // SELECT -> rows, INSERT -> {insertId}
const app = express();
app.use(cors());
app.use(express.json());

// ---------- helpers ----------
const rules = {
  name: [v => v.length >= 20 && v.length <= 60, 'Name must be 20-60 characters'],
  email: [v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'Invalid email'],
  address: [v => v.length <= 400, 'Address max 400 characters'],
  password: [v => /^(?=.*[A-Z])(?=.*[^A-Za-z0-9]).{8,16}$/.test(v), 'Password: 8-16 chars, 1 uppercase, 1 special char'],
};
const validate = (o, keys) => {
  for (const k of keys) if (!rules[k][0](String(o[k] ?? ''))) throw new Error(rules[k][1]);
};
const h = fn => (req, res) => fn(req, res).catch(e =>
  res.status(400).json({ error: e.code === 'ER_DUP_ENTRY' ? 'Already exists' : e.message }));
const auth = (...roles) => (req, res, next) => {
  try {
    req.user = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), process.env.JWT_SECRET);
    if (roles.length && !roles.includes(req.user.role)) return res.sendStatus(403);
    next();
  } catch { res.sendStatus(401); }
};
const token = u => ({
  token: jwt.sign({ id: u.id, role: u.role, name: u.name }, process.env.JWT_SECRET, { expiresIn: '1d' }),
  user: { id: u.id, name: u.name, role: u.role },
});
// filters: list of [queryKey, sqlColumn, exact?]
const where = (query, fields) => {
  const w = [], p = [];
  for (const [k, col, exact] of fields) if (query[k]) {
    p.push(exact ? query[k] : `%${query[k]}%`);
    w.push(`${col} ${exact ? '=' : 'LIKE'} ?`);
  }
  return [w.length ? 'WHERE ' + w.join(' AND ') : '', p];
};
const order = (cols, { sort, order }) =>
  `ORDER BY ${cols.includes(sort) ? sort : cols[0]} ${order === 'desc' ? 'DESC' : 'ASC'}`;

// ---------- auth ----------
app.post('/api/signup', h(async (req, res) => {
  const { name, email, address, password } = req.body;
  validate(req.body, ['name', 'email', 'address', 'password']);
  const r = await q(`INSERT INTO users(name,email,address,password,role) VALUES(?,?,?,?,'user')`,
    [name, email, address, await bcrypt.hash(password, 10)]);
  res.json(token({ id: r.insertId, name, role: 'user' }));
}));

app.post('/api/login', h(async (req, res) => {
  const [u] = await q('SELECT * FROM users WHERE email=?', [req.body.email]);
  if (!u || !(await bcrypt.compare(req.body.password || '', u.password)))
    return res.status(401).json({ error: 'Invalid credentials' });
  res.json(token(u));
}));

app.put('/api/password', auth(), h(async (req, res) => {
  validate(req.body, ['password']);
  await q('UPDATE users SET password=? WHERE id=?', [await bcrypt.hash(req.body.password, 10), req.user.id]);
  res.json({ ok: true });
}));

// ---------- admin ----------
app.get('/api/admin/stats', auth('admin'), h(async (req, res) => {
  const [s] = await q(`SELECT (SELECT COUNT(*) FROM users) AS users,
    (SELECT COUNT(*) FROM stores) AS stores, (SELECT COUNT(*) FROM ratings) AS ratings`);
  res.json(s);
}));

app.post('/api/admin/users', auth('admin'), h(async (req, res) => {
  const { name, email, address, password, role } = req.body;
  validate(req.body, ['name', 'email', 'address', 'password']);
  if (!['admin', 'user', 'owner'].includes(role)) throw new Error('Role must be admin, user or owner');
  await q('INSERT INTO users(name,email,address,password,role) VALUES(?,?,?,?,?)',
    [name, email, address, await bcrypt.hash(password, 10), role]);
  res.json({ ok: true });
}));

app.post('/api/admin/stores', auth('admin'), h(async (req, res) => {
  const { name, email, address, owner_id } = req.body;
  validate(req.body, ['name', 'email', 'address']);
  await q('INSERT INTO stores(name,email,address,owner_id) VALUES(?,?,?,?)',
    [name, email, address, owner_id || null]);
  res.json({ ok: true });
}));

app.get('/api/admin/users', auth('admin'), h(async (req, res) => {
  const [w, p] = where(req.query, [['name', 'u.name'], ['email', 'u.email'], ['address', 'u.address'], ['role', 'u.role', true]]);
  res.json(await q(`SELECT u.id,u.name,u.email,u.address,u.role,
    (SELECT ROUND(AVG(r.rating),1) FROM ratings r JOIN stores s ON s.id=r.store_id WHERE s.owner_id=u.id) AS rating
    FROM users u ${w} ${order(['name', 'email', 'address', 'role', 'rating'], req.query)}`, p));
}));

app.get('/api/admin/stores', auth('admin'), h(async (req, res) => {
  const [w, p] = where(req.query, [['name', 's.name'], ['email', 's.email'], ['address', 's.address']]);
  res.json(await q(`SELECT s.id,s.name,s.email,s.address,ROUND(AVG(r.rating),1) AS rating
    FROM stores s LEFT JOIN ratings r ON r.store_id=s.id ${w} GROUP BY s.id
    ${order(['name', 'email', 'address', 'rating'], req.query)}`, p));
}));

// ---------- normal user ----------
app.get('/api/stores', auth('user'), h(async (req, res) => {
  const [w, p] = where(req.query, [['name', 's.name'], ['address', 's.address']]);
  res.json(await q(`SELECT s.id,s.name,s.address,ROUND(AVG(r.rating),1) AS overall,
    MAX(CASE WHEN r.user_id=? THEN r.rating END) AS my_rating
    FROM stores s LEFT JOIN ratings r ON r.store_id=s.id ${w} GROUP BY s.id
    ${order(['name', 'address', 'overall', 'my_rating'], req.query)}`, [req.user.id, ...p]));
}));

app.post('/api/ratings', auth('user'), h(async (req, res) => {
  const { store_id, rating } = req.body;
  if (!(rating >= 1 && rating <= 5)) throw new Error('Rating must be 1-5');
  await q(`INSERT INTO ratings(user_id,store_id,rating) VALUES(?,?,?)
    ON DUPLICATE KEY UPDATE rating=?`, [req.user.id, store_id, rating, rating]);
  res.json({ ok: true });
}));

// ---------- store owner ----------
app.get('/api/owner/dashboard', auth('owner'), h(async (req, res) => {
  const [avg] = await q(`SELECT ROUND(AVG(r.rating),1) AS average FROM ratings r
    JOIN stores s ON s.id=r.store_id WHERE s.owner_id=?`, [req.user.id]);
  const raters = await q(`SELECT u.id,u.name,u.email,r.rating FROM ratings r
    JOIN users u ON u.id=r.user_id JOIN stores s ON s.id=r.store_id WHERE s.owner_id=?`, [req.user.id]);
  res.json({ average: avg.average, raters });
}));

// ---------- start (seeds a default admin) ----------
(async () => {
  await q(`INSERT IGNORE INTO users(name,email,address,password,role) VALUES(?,?,?,?,'admin')`,
    ['System Administrator Account', 'admin@example.com', 'HQ', await bcrypt.hash('Admin@123', 10)]);
  app.listen(process.env.PORT, () => console.log('API on :' + process.env.PORT));
})();