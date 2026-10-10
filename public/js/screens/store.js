import { api } from '../api.js';
import { SPECIES, buddySvg, cosmeticIcon } from '../buddy.js';
import { elementTag } from '../elements.js';
import { escapeHtml, fmt, toast } from '../fx.js';
import { app } from '../state.js';
import { pointIcon } from './home.js';

// Creatures are the eggs: each one hatches into another beast to raise.
const STORE_CATS = [
  { id: 'accessories', label: 'Accessories', slots: ['hat', 'eyewear', 'accessory'] },
  { id: 'background', label: 'Backgrounds', slots: ['background'] },
  { id: 'creature', label: 'Creatures' },
];
export const diamondIcon = `<svg class="diamond-icon" viewBox="0 0 8 8" shape-rendering="crispEdges" aria-hidden="true">
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

const VIEW_TITLES = { store: 'Store', diamonds: 'Diamonds' };

export function mount(el) {
  let view = 'store';
  let storeCategory = 'accessories';
  let items = null;
  let eggs = null;
  let diamondPackages = null;
  let busy = false;

  // Common and uncommon eggs cost Stride Points; rare and legendary ones cost diamonds.
  function eggsHtml() {
    return `<div class="grid">${eggs.map((egg) => {
      const paidInDiamonds = egg.currency === 'diamonds';
      const balance = paidInDiamonds ? app.diamonds : app.state.user.points;
      const icon = paidInDiamonds ? diamondIcon : pointIcon;
      const name = SPECIES[egg.species].titles.egg;
      return `
      <article class="item ${egg.owned ? 'is-owned' : ''}">
        <div class="item-art">${buddySvg({ species: egg.species, stage: 'egg' }, { background: false })}${egg.owned
          ? '<span class="stamp">Owned</span>'
          : `<span class="price-tag">${icon}${fmt(egg.price)}</span>`}</div>
        <b>${name}</b>
        <span class="rarity" data-rarity="${egg.rarity}">${egg.rarity}</span>${elementTag(egg.element)}${egg.owned
          ? '<span class="owned">With your beasts</span>'
          : `<button class="btn btn-small ${balance < egg.price ? 'is-short' : 'btn-primary'}"
              data-buy-egg="${egg.species}" aria-label="Buy ${name} for ${egg.price} ${paidInDiamonds ? 'diamonds' : 'points'}">
              ${balance < egg.price ? `Need ${fmt(egg.price - balance)}` : 'Buy'}</button>`}
      </article>`;
    }).join('')}</div>`;
  }

  function storeHtml() {
    const { points } = app.state.user;
    const catPills = `
      <div class="segmented segmented-sub" role="tablist" aria-label="Category">
        ${STORE_CATS.map((c) =>
          `<button role="tab" aria-selected="${storeCategory === c.id}" data-cat="${c.id}">${c.label}</button>`
        ).join('')}
      </div>`;

    if (storeCategory === 'creature') return `${catPills}${eggsHtml()}`;

    const activeCat = STORE_CATS.find((c) => c.id === storeCategory);
    const visible = !activeCat?.slots
      ? items
      : items.filter((item) => activeCat.slots.includes(item.slot));

    const grid = visible.length === 0
      ? '<p class="empty">Nothing here yet.</p>'
      : `<div class="grid">${visible.map((item) => {
        // Rare and legendary items cost diamonds; the rest cost Stride Points.
        const paidInDiamonds = item.currency === 'diamonds';
        const balance = paidInDiamonds ? app.diamonds : points;
        return `
        <article class="item ${item.owned ? 'is-owned' : ''}">
          <div class="item-art">${cosmeticIcon(item)}${item.owned
            ? '<span class="stamp">Owned</span>'
            : `<span class="price-tag">${paidInDiamonds ? diamondIcon : pointIcon}${fmt(item.price)}</span>`}</div>
          <b>${escapeHtml(item.name)}</b>${item.rarity
            ? `<span class="rarity" data-rarity="${item.rarity}">${item.rarity}</span>` : ''}${item.owned
            ? '<span class="owned">In your wardrobe</span>'
            : `<button class="btn btn-small ${balance < item.price ? 'is-short' : 'btn-primary'}" data-buy="${item.id}"
                aria-label="Buy ${escapeHtml(item.name)} for ${item.price} ${paidInDiamonds ? 'diamonds' : 'points'}">
                ${balance < item.price ? `Need ${fmt(item.price - balance)}` : 'Buy'}</button>`}
        </article>`;
      }).join('')}</div>`;

    return `${catPills}${grid}`;
  }

  function diamondsHtml() {
    return `
      <div class="coin-grid diamond-grid">${diamondPackages.map((pack) => {
        const amount = pack.diamonds ?? pack.coins ?? 0;
        return `
        <article class="coin-pack diamond-pack ${pack.popular ? 'is-popular' : ''}">
          ${pack.popular ? '<span class="popular">Best value</span>' : ''}
          <div class="coin-pack-art diamond-pack-art">${diamondIcon}</div>
          <b>${escapeHtml(pack.name)}</b>
          <strong>${fmt(amount)} diamonds</strong>
          <button class="btn btn-primary" data-buy-diamonds="${pack.id}">$${(pack.priceCents / 100).toFixed(2)}</button>
        </article>`;
      }).join('')}</div>`;
  }

  function render() {
    if (!app.state?.user) return;
    const title = VIEW_TITLES[view];
    const html = { store: storeHtml, diamonds: diamondsHtml };
    el.innerHTML = `
      <header class="topbar">
        <h1>${title}</h1>
        <div class="topbar-balances">
          <div class="balance" aria-label="${app.state.user.points} Stride Points">${pointIcon}<b>${fmt(app.state.user.points)}</b></div>
          <div class="balance balance-diamonds" aria-label="${app.diamonds} Diamonds">${diamondIcon}<b>${fmt(app.diamonds)}</b></div>
        </div>
      </header>
      <div class="segmented" role="tablist">
        <button role="tab" aria-selected="${view === 'store'}" data-view="store">Store</button>
        <button role="tab" aria-selected="${view === 'diamonds'}" data-view="diamonds">Diamonds</button>
      </div>
      ${items === null || diamondPackages === null ? '<p class="empty">Loading…</p>' : html[view]()}`;
  }

  async function buy(id) {
    const item = items.find((i) => i.id === id);
    const paidInDiamonds = item.currency === 'diamonds';
    const balance = paidInDiamonds ? app.diamonds : app.state.user.points;
    if (balance < item.price) {
      toast(`You need ${fmt(item.price - balance)} more ${paidInDiamonds ? 'diamonds' : 'Stride Points'}.`, 'warn');
      return;
    }
    const result = await api('/store/buy', { method: 'POST', body: { itemId: id } });
    items = result.items;
    app.setState(result);
    toast(`${item.name} is yours! Put it on from the Home screen.`, 'good');
  }

  async function buyEgg(species) {
    const egg = eggs.find((e) => e.species === species);
    const paidInDiamonds = egg.currency === 'diamonds';
    const balance = paidInDiamonds ? app.diamonds : app.state.user.points;
    if (balance < egg.price) {
      toast(`You need ${fmt(egg.price - balance)} more ${paidInDiamonds ? 'diamonds' : 'Stride Points'}.`, 'warn');
      return;
    }
    const result = await api('/store/buy-egg', { method: 'POST', body: { species } });
    eggs = result.eggs;
    app.setState(result);
    toast(`${SPECIES[species].titles.egg} is yours! Find it on the Home screen.`, 'good');
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
      storeCategory = 'accessories';
      return render();
    }
    const catBtn = event.target.closest('[data-cat]');
    if (catBtn) {
      storeCategory = catBtn.dataset.cat;
      return render();
    }
    const buyBtn = event.target.closest('[data-buy]');
    const eggBtn = event.target.closest('[data-buy-egg]');
    const diamondsBtn = event.target.closest('[data-buy-diamonds]');
    if ((!buyBtn && !eggBtn && !diamondsBtn) || busy) return;
    busy = true;
    try {
      if (buyBtn) await buy(buyBtn.dataset.buy);
      else if (eggBtn) await buyEgg(eggBtn.dataset.buyEgg);
      else await buyDiamonds(diamondsBtn.dataset.buyDiamonds);
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
      eggs = data.eggs || [];
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
      eggs = eggs || [];
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