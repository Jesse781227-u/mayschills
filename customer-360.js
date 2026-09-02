(() => {
    const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character]));
    const money = value => '₦' + Number(value || 0).toLocaleString('en-NG');
    const dateLabel = value => value ? new Date(value).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
    const statusLabel = value => ({ received: 'New', preparing: 'Preparing', ready: 'Ready', in_transit: 'In transit', delivered: 'Delivered', picked_up: 'Picked up', cancelled: 'Cancelled' }[value] || value || 'Unknown');
    const api = () => (window.MAYCHILLS_API_URL || 'https://mayschillsbackend.onrender.com') + '/api';
    const styles = `.c360{color:var(--ink)}.c360-hero{display:flex;gap:14px;align-items:center;padding:4px 0 18px}.c360-avatar{width:58px;height:58px;border-radius:16px;display:grid;place-items:center;background:var(--soft);color:var(--primary);font-size:25px;font-weight:800}.c360 h2{margin:5px 0 4px;font-size:25px}.c360-recency{margin:0;font-size:14px}.c360-recency strong{display:block;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}.c360-recency small{display:block;color:var(--muted);margin-top:3px}.c360-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:15px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.c360-stats div{min-width:0}.c360-stats strong,.c360-stats small{display:block}.c360-stats strong{font-size:17px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.c360-stats small,.c360-overview small{color:var(--muted);font-size:11px;margin-top:4px}.c360-section{border-top:1px solid var(--line);padding:18px 0}.c360-section h3{margin:0 0 13px;font-size:12px;text-transform:uppercase;letter-spacing:.1em}.c360-section h4{margin:14px 0 7px;font-size:12px;color:var(--muted)}.c360-contact-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.c360-contact,.c360-address{display:flex;gap:8px;align-items:flex-start;padding:8px 0;border-bottom:1px solid #eef2ef}.c360-contact span,.c360-address span{flex:1;overflow-wrap:anywhere}.c360 a{color:var(--primary);font-size:11px;font-weight:700;text-decoration:none}.c360-address{display:grid;grid-template-columns:100px 1fr auto}.c360-address strong{font-size:11px}.c360-overview{display:grid;grid-template-columns:1fr 1fr;gap:12px}.c360-overview>div{padding:11px;background:var(--bg);border-radius:8px}.c360-overview small,.c360-overview strong,.c360-overview span{display:block}.c360-overview strong{font-size:13px;margin-top:5px}.c360-overview span{font-size:12px;color:var(--muted);margin-top:4px}.c360-favorites>div{display:grid;grid-template-columns:25px 1fr auto;gap:8px;align-items:center;padding:10px 0;border-bottom:1px solid #eef2ef}.c360-rank{color:var(--primary);font-weight:800}.c360-favorites strong{font-size:11px;color:var(--muted)}.c360-order{border-bottom:1px solid #eef2ef}.c360-order summary{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:13px 0;cursor:pointer;list-style:none}.c360-order summary::-webkit-details-marker{display:none}.c360-order summary>span strong,.c360-order summary>span small{display:block}.c360-order summary small{color:var(--muted);margin-top:4px}.c360-order-body{padding:0 0 14px}.c360-items{margin:12px 0;border-top:1px solid #eef2ef}.c360-items div,.c360-order-total{display:flex;justify-content:space-between;gap:10px;padding:9px 0;border-bottom:1px solid #eef2ef}.c360-order-total{border-top:1px solid var(--line);margin-top:8px}.c360-section-head{display:flex;justify-content:space-between;align-items:center}.c360-note{white-space:pre-wrap;color:var(--muted);line-height:1.55}.c360-note-edit{width:100%;min-height:90px;border:1px solid var(--line);padding:10px;font:inherit}.c360-note-actions{display:flex;gap:8px;margin-top:8px}@media(max-width:640px){.c360-contact-grid,.c360-overview{grid-template-columns:1fr}.c360-address{grid-template-columns:88px 1fr}.c360-address a{grid-column:2}.c360 h2{font-size:21px}}`;
    document.head.insertAdjacentHTML('beforeend', `<style>${styles}</style>`);
    const render = customer => {
        const history = [...(customer.history || [])].sort((a, b) => new Date(b.date) - new Date(a.date));
        const last = history[0];
        const first = history.at(-1);
        const daysSince = last ? Math.max(0, Math.floor((Date.now() - new Date(last.date)) / 86400000)) : null;
        const gaps = history.slice(1).map((item, index) => (new Date(history[index].date) - new Date(item.date)) / 86400000);
        const frequency = gaps.length ? Math.round(gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length) : null;
        const phones = customer.phones?.length ? customer.phones : [customer.phone].filter(Boolean);
        const emails = customer.emails?.length ? customer.emails : [customer.email].filter(Boolean);
        const addresses = (customer.addresses || []).filter(Boolean);
        const items = (customer.favoriteItems || customer.items || []).map(item => ({ ...item, quantity: Number(item.quantity ?? item.units ?? item.orders ?? 0), orders: Number(item.orders ?? item.quantity ?? 0) })).slice(0, 5);
        const itemCount = order => (order.items || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0);
        const historyMarkup = history.map(order => `<details class="c360-order"><summary><span><strong>${dateLabel(order.date)}</strong><small>${itemCount(order)} item${itemCount(order) === 1 ? '' : 's'} · ${escapeHtml(statusLabel(order.status))}</small></span><strong>${money(order.total)}</strong></summary><div class="c360-order-body"><div class="muted">${escapeHtml(order.reference || 'Order')} · ${new Date(order.date).toLocaleTimeString('en-NG', { hour: 'numeric', minute: '2-digit' })}</div><div class="c360-items">${(order.items || []).map(item => `<div><span>${escapeHtml(item.quantity)} × ${escapeHtml(item.name)}</span>${item.price == null ? '' : `<strong>${money(Number(item.price) * Number(item.quantity || 0))}</strong>`}</div>`).join('') || '<span class="muted">No item details available.</span>'}</div><div class="c360-order-total"><span>Total</span><strong>${money(order.total)}</strong></div><div class="muted">${escapeHtml(order.address || 'No address recorded')} · ${escapeHtml(statusLabel(order.status))}</div></div></details>`).join('');
        document.getElementById('drawer-content').innerHTML = `<div class="c360"><div class="c360-hero"><div class="c360-avatar">${escapeHtml((customer.name || '?').slice(0, 1).toUpperCase())}</div><div><span class="segment">${escapeHtml(customer.segment)}</span><h2>${escapeHtml(customer.name)}</h2><p class="c360-recency"><strong>Last ordered</strong>${daysSince === null ? 'No orders' : daysSince === 0 ? 'Today' : `${daysSince} day${daysSince === 1 ? '' : 's'} ago`}<small>${last ? dateLabel(last.date) : '—'}</small></p></div></div><div class="c360-stats"><div><strong>${customer.orders}</strong><small>Orders</small></div><div><strong>${money(customer.spent)}</strong><small>Total spent</small></div><div><strong>${money(customer.averageOrderValue)}</strong><small>Avg. order</small></div></div><section class="c360-section"><h3>Contact information</h3><div class="c360-contact-grid"><div><h4>Phone</h4>${phones.map(value => `<div class="c360-contact"><span>${escapeHtml(value)}</span><a href="tel:${escapeHtml(value)}">Call</a></div>`).join('') || '<span class="muted">No phone recorded</span>'}</div><div><h4>Email</h4>${emails.map(value => `<div class="c360-contact"><span>${escapeHtml(value)}</span><a href="mailto:${escapeHtml(value)}">Email</a></div>`).join('') || '<span class="muted">No email recorded</span>'}</div></div><h4>Addresses</h4>${addresses.map((value, index) => `<div class="c360-address"><strong>${index ? `Address ${index + 1}` : 'Primary address'}</strong><span>${escapeHtml(value)}</span><a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(value)}" target="_blank" rel="noreferrer">Address</a></div>`).join('') || '<span class="muted">No address recorded</span>'}</section><section class="c360-section"><h3>Customer overview</h3><div class="c360-overview"><div><small>Most ordered</small><strong>${escapeHtml(items[0]?.name || customer.favoriteProduct || '—')}</strong><span>${items[0]?.quantity ? `${items[0].quantity} purchased` : 'Not enough history'}</span></div><div><small>First ordered</small><strong>${first ? dateLabel(first.date) : '—'}</strong></div><div><small>Last ordered</small><strong>${last ? dateLabel(last.date) : '—'}</strong></div><div><small>Typical frequency</small><strong>${frequency ? `Every ~${frequency} days` : 'Not enough history'}</strong></div></div></section><section class="c360-section"><h3>Frequently ordered</h3><div class="c360-favorites">${items.map((item, index) => `<div><span class="c360-rank">${index + 1}</span><span>${escapeHtml(item.name)}</span><strong>${item.quantity} purchased</strong></div>`).join('') || '<span class="muted">Not enough history.</span>'}</div></section><section class="c360-section"><h3>Order history</h3>${historyMarkup || '<span class="muted">No order history.</span>'}</section><section class="c360-section"><div class="c360-section-head"><h3>Notes</h3><button class="btn secondary" data-c360-note-add="${escapeHtml(customer.key)}">+ Add note</button></div><div class="c360-note" data-c360-note="${escapeHtml(customer.key)}">${escapeHtml(customer.notes || 'No staff notes yet.')}</div></section></div>`;
        document.getElementById('drawer-backdrop').classList.remove('hidden');
        document.getElementById('drawer').classList.remove('hidden');
    };
    const loadAndRender = async key => {
        try {
            const response = await fetch(`${api()}/admin/analytics?from=2000-01-01&to=2100-01-01`, { headers: { Authorization: `Bearer ${sessionStorage.getItem('maychills_admin_token')}` } });
            if (!response.ok) return;
            const data = await response.json();
            const customer = (data.customers || []).find(item => item.key === key);
            if (customer) render(customer);
        } catch (_) { /* Existing drawer remains available if the profile request fails. */ }
    };
    document.addEventListener('click', event => {
        const row = event.target.closest('[data-customer]');
        if (!row) return;
        const key = row.dataset.customer;
        setTimeout(() => loadAndRender(key), 0);
    });
    document.addEventListener('click', async event => {
        const button = event.target.closest('[data-c360-note-add]');
        if (!button) return;
        const container = button.closest('.c360-section');
        const note = container.querySelector('[data-c360-note]');
        const current = note.textContent === 'No staff notes yet.' ? '' : note.textContent;
        note.innerHTML = `<textarea class="c360-note-edit">${escapeHtml(current)}</textarea><div class="c360-note-actions"><button class="btn primary" data-c360-note-save="${escapeHtml(button.dataset.c360NoteAdd)}">Save</button><button class="btn secondary" data-c360-note-cancel>Cancel</button></div>`;
    });
    document.addEventListener('click', async event => {
        const save = event.target.closest('[data-c360-note-save]');
        if (!save) return;
        const section = save.closest('.c360-section');
        const notes = section.querySelector('textarea').value;
        save.disabled = true;
        try {
            const response = await fetch(`${api()}/admin/customers/${encodeURIComponent(save.dataset.c360NoteSave)}/notes`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionStorage.getItem('maychills_admin_token')}` }, body: JSON.stringify({ notes }) });
            if (!response.ok) throw new Error('Unable to save note');
            section.querySelector('[data-c360-note]').textContent = notes || 'No staff notes yet.';
        } catch (_) { save.disabled = false; }
    });
    document.addEventListener('click', event => {
        const cancel = event.target.closest('[data-c360-note-cancel]');
        if (cancel) cancel.closest('.c360-section').querySelector('[data-c360-note]').textContent = 'No staff notes yet.';
    });
})();

const customer360Escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character]));
const customer360Api = () => (window.MAYCHILLS_API_URL || 'https://mayschillsbackend.onrender.com') + '/api';
const customer360Observer = new MutationObserver(() => {
    document.querySelectorAll('[data-c360-note-add]').forEach(button => {
        const note = button.closest('.c360-section')?.querySelector('[data-c360-note]');
        if (!note || button.dataset.enhanced) return;
        button.dataset.enhanced = 'true';
        if (note.textContent.trim() !== 'No staff notes yet.') {
            button.textContent = 'Edit note';
            button.insertAdjacentHTML('afterend', `<button class="btn secondary" data-c360-note-delete="${customer360Escape(button.dataset.c360NoteAdd)}">Delete note</button>`);
        }
    });
});
document.addEventListener('DOMContentLoaded', () => customer360Observer.observe(document.body, { childList: true, subtree: true }));
document.addEventListener('click', async event => {
    const button = event.target.closest('[data-c360-note-delete]');
    if (!button) return;
    const response = await fetch(`${customer360Api()}/admin/customers/${encodeURIComponent(button.dataset.c360NoteDelete)}/notes`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionStorage.getItem('maychills_admin_token')}` }, body: JSON.stringify({ notes: '' }) });
    if (response.ok) {
        const section = button.closest('.c360-section');
        section.querySelector('[data-c360-note]').textContent = 'No staff notes yet.';
        section.querySelector('[data-c360-note-add]').textContent = '+ Add note';
        button.remove();
    }
});
