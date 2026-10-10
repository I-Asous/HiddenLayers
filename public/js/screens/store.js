import { api } from '../api.js';
import { buddySvg, cosmeticIcon } from '../buddy.js';
import { escapeHtml, fmt, toast } from '../fx.js';
import { app } from '../state.js';
import { pointIcon } from './home.js';

const SLOT_LABELS = { hat: 'Hats', eyewear: 'Eyewear', accessory: 'Accessories', background: 'Backgrounds' };
const diamondIcon = `<svg class="diamond-icon" viewBox="0 0 8 8" shape-rendering="crispEdges" aria-hidden="true">
  <!-- outline -->
  <path d="M3 0h2v1h1v1h1v1h1v1h-1v1h-1v1h-1v1h-2v-1h-1v-1h-1v-1h-1v-1h1v-1h1v-1h1z" fill="#1a1c2c"/>
  <!-- body -->
  <path d="M3 1h2v1h1v1h1v1h-1v1h-1v1h-2v-1h-1v-1h-1v-1h1v-1h1z" fill="#5fcde4"/>
  <!-- top facet (lighter) -->
  <path d="M3 1h2v1h-2z" fill="#a8e4f0"/>
  <!-- left facet -->
  <path d="M3 2h1v2h-1v-1h-1v-1h1z" fill="#73c5d8"/>
  <!-- right facet -->
  <path d="M5 2h1v1h-1v1h-1v-2h1z" fill="#3db0c8"/>
  <!-- bottom tip -->
  <path d="M4 5h0v1h0z" fill="#3db0c8"/>
  <!-- glint -->
  <path d="M3 2h1v1h-1z" fill="#d6f4ff"/>
</svg>`;

const DEFAULT_DIAMOND_PACKAGES = [
  { id: 'diamonds_50', name: 'Handful of Diamonds', diamonds: 50, priceCents: 99, popular: false },
  { id: 'diamonds_300', name: 'Diamond Pouch', diamonds: 300, priceCents: 499, popular: true },
  { id: 'diamonds_750', name: 'Diamond Vault', diamonds: 750, priceCents: 999, popular: false },
];

export function mount(el) {
  let view = 'store';
  let items = null;
  let diamondPackages = null;
  let busy = false;

  function storeHtml() {
    const { points } = app.state.user;
    return `<div class="grid">${items.map((item) => `
      <article class="item ${item.owned ? 'is-owned' : ''}">
        <div class="item-art">${cosmeticIcon(item)}${item.owned
          ? '<span class="stamp">Owned</span>'
          : `<span class="price-tag">${pointIcon}${fmt(item.price)}</span>`}</div>
        <b>${escapeHtml(item.name)}</b>${item.owned
          ? '<span class="owned">In your wardrobe</span>'
          : `<button class="btn btn-small ${points < item.price ? 'is-short' : 'btn-primary'}"
              data-buy="${item.id}" aria-label="Buy ${escapeHtml(item.name)} for ${item.price} points">
              ${points < item.price ? `Need ${fmt(item.price - points)}` : 'Buy'}</button>`}
      </article>`).join('')}</div>`;
  }

  function wardrobeHtml() {
    const { buddy } = app.state;
    const owned = items.filter((item) => item.owned);
    const slots = Object.entries(SLOT_LABELS).map(([slot, label]) => {
      const inSlot = owned.filter((item) => item.slot === slot);
      if (!inSlot.length) return '';
      return `
        <h3>${label}</h3>
        <div class="grid grid-3">${inSlot.map((item) => {
          const on = buddy.equipped[slot] === item.id;
          return `
            <button class="item item-tap ${on ? 'is-equipped' : ''}" data-equip="${item.id}" data-slot="${slot}"
              aria-pressed="${on}">
              <div class="item-art">${cosmeticIcon(item)}</div>
              <b>${escapeHtml(item.name)}</b>
              <span class="owned">${on ? 'Wearing' : 'Tap to wear'}</span>
            </button>`;
        }).join('')}</div>`;
    }).join('');
    return `
      <div class="preview">${buddySvg(buddy, { className: 'is-idle' })}</div>
      ${slots || '<p class="empty">Your wardrobe is empty. Buy something in the Store!</p>'}`;
  }

  function diamondsHtml() {
    const currentDiamonds = app.diamonds;
    return `
      <section class="coin-hero diamond-hero">
        <div class="coin-balance diamond-balance">${diamondIcon}<span><small>Your diamond balance</small><b>${fmt(currentDiamonds)}</b></span></div>
        <p>Use diamonds for special offers and future upgrades. This demo purchase adds diamonds instantly.</p>
      </section>
      <div class="coin-grid diamond-grid">${diamondPackages.map((pack) => {
        const amount = pack.diamonds ?? pack.coins ?? 0;
        return `
        <article class="coin-pack diamond-pack ${pack.popular ? 'is-popular' : ''}">
          ${pack.popular ? '<span class="popular">Best value</span>' : ''}
          <div class="coin-pack-art diamond-pack-art">${diamondIcon}</div>
          <b>${escapeHtml(pack.name)}</b>
          <strong>${fmt(amount)} diamonds</strong>
          <button class="btn btn-primary" data-buy-diamonds="${pack.id}">$${(pack.priceCents / 100).toFixed(2)} · Add diamonds</button>
        </article>`;
      }).join('')}</div>`;
  }

  function render() {
    if (!app.state?.user) return;
    const title = view === 'store' ? 'Store' : view === 'diamonds' ? 'Diamonds' : 'Wardrobe';
    el.innerHTML = `
      <header class="topbar">
        <h1>${title}</h1>
        <div class="balance" aria-label="${app.state.user.points} Stride Points">${pointIcon}<b>${fmt(app.state.user.points)}</b></div>
      </header>
      <div class="segmented" role="tablist">
        <button role="tab" aria-selected="${view === 'store'}" data-view="store">Store</button>
        <button role="tab" aria-selected="${view === 'diamonds'}" data-view="diamonds">Diamonds</button>
        <button role="tab" aria-selected="${view === 'wardrobe'}" data-view="wardrobe">Wardrobe</button>
      </div>
      ${items === null || diamondPackages === null ? '<p class="empty">Loading…</p>' : view === 'store' ? storeHtml() : view === 'diamonds' ? diamondsHtml() : wardrobeHtml()}`;
  }

  async function buy(id) {
    const item = items.find((i) => i.id === id);
    const { points } = app.state.user;
    if (points < item.price) {
      toast(`You need ${fmt(item.price - points)} more Stride Points.`, 'warn');
      return;
    }
    const result = await api('/store/buy', { method: 'POST', body: { itemId: id } });
    items = result.items;
    app.setState(result);
    toast(`${item.name} is yours! Find it in your Wardrobe.`, 'good');
  }

  async function equip(id, slot) {
    const wearing = app.state.buddy.equipped[slot] === id;
    app.setState(await api('/buddy/equip', { method: 'POST', body: { slot, itemId: wearing ? null : id } }));
  }

  async function buyDiamonds(id) {
    const pack = diamondPackages.find((p) => p.id === id);
    const amount = pack?.diamonds ?? pack?.coins ?? 0;
    try {
      let result;
      try {
        result = await api('/store/buy-diamonds', { method: 'POST', body: { packageId: id } });
      } catch {
        // Fallback in case backend route is still /store/buy-coins
        result = await api('/store/buy-coins', { method: 'POST', body: { packageId: id } });
      }
      app.setState(result);
      const added = result?.purchased?.diamonds ?? result?.purchased?.coins ?? amount;
      toast(`${fmt(added)} diamonds added to your wallet!`, 'good');
    } catch {
      // Local/demo fallback
      if (pack) {
        app.addDiamonds(amount);
        toast(`${fmt(amount)} diamonds added to your wallet!`, 'good');
      }
    }
  }

  const onClick = async (event) => {
    const tab = event.target.closest('[data-view]');
    if (tab) {
      view = tab.dataset.view;
      return render();
    }
    const buyBtn = event.target.closest('[data-buy]');
    const equipBtn = event.target.closest('[data-equip]');
    const diamondsBtn = event.target.closest('[data-buy-diamonds]');
    if ((!buyBtn && !equipBtn && !diamondsBtn) || busy) return;
    busy = true;
    try {
      if (buyBtn) await buy(buyBtn.dataset.buy);
      else if (diamondsBtn) await buyDiamonds(diamondsBtn.dataset.buyDiamonds);
      else await equip(equipBtn.dataset.equip, equipBtn.dataset.slot);
    } catch (err) {
      toast(err.message, 'warn');
    } finally {
      busy = false;
    }
  };

  const onStateChange = () => render();

  el.addEventListener('click', onClick);
  app.addEventListener('change', onStateChange);
  render();

  api('/store')
    .then((data) => {
      items = data.items || [];
      const rawPackages = data.diamondPackages || data.coinPackages || DEFAULT_DIAMOND_PACKAGES;
      diamondPackages = rawPackages.map((p) => ({
        ...p,
        name: p.name.replace(/coins?/gi, 'Diamonds'),
        diamonds: p.diamonds ?? p.coins ?? 0,
      }));
      render();
    })
    .catch((err) => {
      items = items || [];
      diamondPackages = DEFAULT_DIAMOND_PACKAGES;
      render();
      toast(err.message, 'warn');
    });

  return {
    update: render,
    destroy: () => {
      el.removeEventListener('click', onClick);
      app.removeEventListener('change', onStateChange);
    },
  };
}