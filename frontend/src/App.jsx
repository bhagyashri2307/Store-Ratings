import { useState, useEffect } from 'react';

const API = 'http://localhost:5000/api';
const call = async (path, method = 'GET', body) => {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.token },
    body: body && JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Error ' + res.status);
  return data;
};
const label = c => c.replace('_', ' ');

// Generic form: fields = list of input names
function Form({ fields, onSubmit, button }) {
  const [v, setV] = useState({});
  const [msg, setMsg] = useState(null);
  const submit = async e => {
    e.preventDefault();
    try { const t = await onSubmit(v); setMsg(t ? { text: t, ok: true } : null); }
    catch (err) { setMsg({ text: err.message, ok: false }); }
  };
  return (
    <form className="form" onSubmit={submit}>
      {fields.map(f => (
        <input key={f} placeholder={label(f)} type={f === 'password' ? 'password' : 'text'}
          value={v[f] || ''} onChange={e => setV({ ...v, [f]: e.target.value })} />
      ))}
      <button>{button}</button>
      {msg && <span className={'msg ' + (msg.ok ? 'ok' : 'err')}>{msg.text}</span>}
    </form>
  );
}

// Generic table: filters + click-header sorting
function List({ url, cols, filters = [], extra }) {
  const [rows, setRows] = useState([]);
  const [f, setF] = useState({});
  const [sort, setSort] = useState(cols[0]);
  const [dir, setDir] = useState('asc');
  const load = () => call(`${url}?${new URLSearchParams({ ...f, sort, order: dir })}`).then(setRows);
  useEffect(() => { load(); }, [sort, dir]);
  const clickSort = c => { setDir(sort === c && dir === 'asc' ? 'desc' : 'asc'); setSort(c); };
  return (
    <div>
      <div className="toolbar">
        {filters.map(k => <input key={k} placeholder={'Filter ' + k} onChange={e => setF({ ...f, [k]: e.target.value })} />)}
        {filters.length > 0 && <button onClick={load}>Search</button>}
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr>
            {cols.map(c => <th key={c} className="sortable" onClick={() => clickSort(c)}>
              {label(c)}{sort === c ? (dir === 'asc' ? ' ▲' : ' ▼') : ''}</th>)}
            {extra && <th>Action</th>}
          </tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id}>
                {cols.map(c => <td key={c}>{r[c] ?? '-'}</td>)}
                {extra && <td>{extra(r, load)}</td>}
              </tr>
            ))}
            {rows.length === 0 && <tr><td className="empty" colSpan={cols.length + 1}>No records found</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Admin() {
  const [stats, setStats] = useState({});
  useEffect(() => { call('/admin/stats').then(setStats); }, []);
  const add = path => async v => { await call(path, 'POST', v); return 'Added (click Search to refresh)'; };
  return (
    <div>
      <div className="stats">
        <div className="stat"><b>{stats.users}</b><span>Users</span></div>
        <div className="stat"><b>{stats.stores}</b><span>Stores</span></div>
        <div className="stat"><b>{stats.ratings}</b><span>Ratings</span></div>
      </div>
      <div className="card">
        <h3>Add user (role: admin / user / owner)</h3>
        <Form fields={['name', 'email', 'address', 'password', 'role']} button="Add user" onSubmit={add('/admin/users')} />
      </div>
      <div className="card">
        <h3>Add store (owner_id optional)</h3>
        <Form fields={['name', 'email', 'address', 'owner_id']} button="Add store" onSubmit={add('/admin/stores')} />
      </div>
      <div className="card">
        <h3>Users</h3>
        <List url="/admin/users" cols={['name', 'email', 'address', 'role', 'rating']} filters={['name', 'email', 'address', 'role']} />
      </div>
      <div className="card">
        <h3>Stores</h3>
        <List url="/admin/stores" cols={['name', 'email', 'address', 'rating']} filters={['name', 'email', 'address']} />
      </div>
    </div>
  );
}

function UserStores() {
  const rate = (r, load) => (
    <select value={r.my_rating || ''} onChange={async e => {
      await call('/ratings', 'POST', { store_id: r.id, rating: +e.target.value }); load();
    }}>
      <option value="" disabled>Rate</option>
      {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n} ★</option>)}
    </select>
  );
  return (
    <div className="card">
      <h3>Stores</h3>
      <List url="/stores" cols={['name', 'address', 'overall', 'my_rating']} filters={['name', 'address']} extra={rate} />
    </div>
  );
}

function Owner() {
  const [d, setD] = useState({ raters: [] });
  useEffect(() => { call('/owner/dashboard').then(setD); }, []);
  return (
    <div>
      <div className="stats">
        <div className="stat"><b>{d.average ?? '-'}</b><span>Average rating</span></div>
        <div className="stat"><b>{d.raters.length}</b><span>Total raters</span></div>
      </div>
      <div className="card">
        <h3>Users who rated your store</h3>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Email</th><th>Rating</th></tr></thead>
            <tbody>
              {d.raters.map(r => <tr key={r.id}><td>{r.name}</td><td>{r.email}</td><td>{r.rating} ★</td></tr>)}
              {d.raters.length === 0 && <tr><td className="empty" colSpan="3">No ratings yet</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState(JSON.parse(localStorage.user || 'null'));
  const [signup, setSignup] = useState(false);
  const login = async (path, v) => {
    const d = await call(path, 'POST', v);
    localStorage.token = d.token; localStorage.user = JSON.stringify(d.user); setUser(d.user);
  };
  const logout = () => { localStorage.clear(); setUser(null); };

  if (!user) return (
    <div className="card auth">
      <h2>{signup ? 'Create account' : 'Store Ratings'}</h2>
      <Form key={signup} button={signup ? 'Sign up' : 'Login'}
        fields={signup ? ['name', 'email', 'address', 'password'] : ['email', 'password']}
        onSubmit={v => login(signup ? '/signup' : '/login', v)} />
      <button className="link" onClick={() => setSignup(!signup)}>
        {signup ? 'Have an account? Login' : 'New user? Sign up'}</button>
    </div>
  );

  return (
    <div>
      <div className="header">
        <div className="container">
          <span className="brand">★ Store Ratings</span>
          <span>{user.name}<span className="badge">{user.role}</span>
            {' '}<button className="light" onClick={logout}>Logout</button></span>
        </div>
      </div>
      <div className="container">
        <div className="card">
          <h3>Change password</h3>
          <Form fields={['password']} button="Update" onSubmit={async v => { await call('/password', 'PUT', v); return 'Password updated'; }} />
        </div>
        {user.role === 'admin' && <Admin />}
        {user.role === 'user' && <UserStores />}
        {user.role === 'owner' && <Owner />}
      </div>
    </div>
  );
}