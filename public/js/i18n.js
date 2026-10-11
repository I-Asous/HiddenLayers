/**
 * Lightweight i18n module.
 * Usage: import { t, lang, setLang, LANGUAGES } from './i18n.js';
 *        t('nav_home')  → 'Home' / 'Inicio' / …
 */

const LANG_KEY = 'stepbuddy.lang';

export const LANGUAGES = [
  { id: 'en', label: 'English' },
  { id: 'es', label: 'Español' },
  { id: 'fr', label: 'Français' },
  { id: 'pt', label: 'Português' },
  { id: 'ja', label: '日本語' },
];

// ── Extra strings (login / map / app-level) not in the initial batch ──────────
const EXTRA = {
  login_returning:   { en: 'Welcome back! Your buddy is waiting.', es: '¡Bienvenido de vuelta! Tu compañero te espera.', fr: 'Content de te revoir ! Ton compagnon t\'attend.', pt: 'Bem-vindo de volta! Seu companheiro está esperando.', ja: 'おかえり！バディが待っています。' },
  login_signup:      { en: 'Hatch a mythical beast and raise it with every step you take.', es: 'Hace eclosionar una bestia mítica y críala con cada paso.', fr: 'Fais éclore une créature mythique et élève-la à chaque pas.', pt: 'Choque uma criatura mítica e crie-a a cada passo.', ja: '神話の生物を孵化させ、一歩一歩育てましょう。' },
  login_egg:         { en: 'A mystery egg is waiting for you. Walk to find out what hatches!', es: 'Un huevo misterioso te espera. ¡Camina para descubrir qué eclosiona!', fr: 'Un œuf mystérieux t\'attend. Marche pour découvrir ce qui éclot !', pt: 'Um ovo misterioso está esperando por você. Caminhe para descobrir o que choca!', ja: '謎の卵があなたを待っています。歩いて何が孵化するか確かめましょう！' },
  login_username:    { en: 'Username',           es: 'Nombre de usuario', fr: 'Nom d\'utilisateur', pt: 'Nome de usuário', ja: 'ユーザー名' },
  login_choose_user: { en: 'Choose a username',  es: 'Elige un nombre de usuario', fr: 'Choisis un nom d\'utilisateur', pt: 'Escolha um nome de usuário', ja: 'ユーザー名を選んでください' },
  login_buddy_name:  { en: 'Name your buddy',    es: 'Nombra a tu compañero', fr: 'Nomme ton compagnon', pt: 'Nomeie seu companheiro', ja: 'バディに名前をつける' },
  login_btn:         { en: 'Log in',             es: 'Iniciar sesión', fr: 'Se connecter', pt: 'Entrar', ja: 'ログイン' },
  login_next:        { en: 'Next',               es: 'Siguiente',     fr: 'Suivant',       pt: 'Próximo', ja: '次へ' },
  login_start:       { en: 'Start',              es: 'Empezar',       fr: 'Commencer',     pt: 'Começar', ja: 'スタート' },
  login_no_password: { en: 'No password needed.', es: 'Sin contraseña.', fr: 'Pas de mot de passe.', pt: 'Sem senha.', ja: 'パスワード不要。' },
  login_to_signup:   { en: 'New here? Hatch a buddy', es: '¿Eres nuevo? Crea un compañero', fr: 'Nouveau ? Fais éclore un compagnon', pt: 'Novo aqui? Choque um companheiro', ja: '初めて？バディを孵化させよう' },
  login_to_login:    { en: 'Already have a buddy? Log in', es: '¿Ya tienes compañero? Inicia sesión', fr: 'Tu as déjà un compagnon ? Connecte-toi', pt: 'Já tem um companheiro? Entrar', ja: 'バディがいる？ログイン' },
  login_back:        { en: 'Back',               es: 'Atrás',         fr: 'Retour',        pt: 'Voltar', ja: '戻る' },

  map_title:         { en: 'Map',                es: 'Mapa',          fr: 'Carte',         pt: 'Mapa',    ja: 'マップ' },
  map_start_walk:    { en: 'Start Walk',         es: 'Iniciar caminata', fr: 'Démarrer la marche', pt: 'Iniciar caminhada', ja: '歩行開始' },
  map_end_walk:      { en: 'End Walk',           es: 'Finalizar caminata', fr: 'Terminer la marche', pt: 'Finalizar caminhada', ja: '歩行終了' },
  map_loading:       { en: 'Loading map…',       es: 'Cargando mapa…', fr: 'Chargement de la carte…', pt: 'Carregando mapa…', ja: 'マップを読み込み中…' },
  map_finding:       { en: 'Finding you…',       es: 'Encontrándote…', fr: 'Localisation en cours…', pt: 'Localizando você…', ja: '位置を特定中…' },
  map_distance:      { en: 'Distance',           es: 'Distancia',     fr: 'Distance',      pt: 'Distância', ja: '距離' },
  map_steps:         { en: 'Steps',              es: 'Pasos',         fr: 'Pas',           pt: 'Passos',  ja: 'ステップ' },
  map_points:        { en: 'Points',             es: 'Puntos',        fr: 'Points',        pt: 'Pontos',  ja: 'ポイント' },
};

const STRINGS = {
  // ── Nav tabs ───────────────────────────────────────────────────────────────
  nav_home:    { en: 'Home',    es: 'Inicio',    fr: 'Accueil',  pt: 'Início',  ja: 'ホーム' },
  nav_walk:    { en: 'Walk',    es: 'Caminar',   fr: 'Marcher',  pt: 'Caminhar',ja: 'ウォーク' },
  nav_map:     { en: 'Map',     es: 'Mapa',      fr: 'Carte',    pt: 'Mapa',    ja: 'マップ' },
  nav_battle:  { en: 'Battle',  es: 'Batalla',   fr: 'Combat',   pt: 'Batalha', ja: 'バトル' },
  nav_store:   { en: 'Store',   es: 'Tienda',    fr: 'Boutique', pt: 'Loja',    ja: 'ストア' },
  nav_stats:   { en: 'Stats',   es: 'Estadísticas', fr: 'Stats', pt: 'Estatísticas', ja: '統計' },

  // ── Home screen ────────────────────────────────────────────────────────────
  home_fully_grown:     { en: 'Fully grown!',  es: '¡Completamente crecido!', fr: 'Complètement grandi !', pt: 'Totalmente crescido!', ja: '完全に成長しました！' },
  home_level_up:        { en: 'Level Up',      es: 'Subir nivel',  fr: 'Niveau suivant', pt: 'Subir nível', ja: 'レベルアップ' },
  home_attack_up:       { en: '+1 Attack',     es: '+1 Ataque',    fr: '+1 Attaque',     pt: '+1 Ataque',   ja: '攻撃+1' },
  home_evasion_up:      { en: '+1 Evasion',    es: '+1 Evasión',   fr: '+1 Évasion',     pt: '+1 Evasão',   ja: '回避+1' },
  home_need_points:     { en: 'Need {n}',      es: 'Necesitas {n}',fr: '{n} manquants',  pt: 'Faltam {n}',  ja: '{n}不足' },
  home_open_profile:    { en: 'Open profile',  es: 'Abrir perfil', fr: 'Ouvrir profil',  pt: 'Abrir perfil',ja: 'プロフィール' },
  home_walking_with:    { en: 'walking with you', es: 'caminando contigo', fr: 'marche avec toi', pt: 'caminhando com você', ja: 'あなたと歩いています' },
  home_buddy_shy:       { en: 'Your buddy is feeling shy. Try again in a moment.', es: 'Tu compañero está tímido. Inténtalo de nuevo.', fr: 'Ton compagnon est timide. Réessaie dans un moment.', pt: 'Seu companheiro está tímido. Tente novamente.', ja: 'バディが恥ずかしがっています。また後で試してください。' },
  home_need_more_points:{ en: 'You need {n} more Stride Points. Time for a walk!', es: 'Necesitas {n} Stride Points más. ¡Hora de caminar!', fr: 'Il te faut {n} Stride Points de plus. En route !', pt: 'Você precisa de {n} Stride Points a mais. Hora de caminhar!', ja: 'あと{n}ストライドポイントが必要です。歩きましょう！' },

  // ── Evolution overlay ──────────────────────────────────────────────────────
  evolution_title: { en: 'Evolution!', es: '¡Evolución!', fr: 'Évolution !', pt: 'Evolução!', ja: '進化！' },
  evolution_yay:   { en: 'Yay!',       es: '¡Hurra!',     fr: 'Youpi !',     pt: 'Eba!',       ja: 'やった！' },

  // ── Walk screen ────────────────────────────────────────────────────────────
  walk_title:          { en: 'Walk Mode',        es: 'Modo Caminar',    fr: 'Mode Marche',    pt: 'Modo Caminhar',   ja: 'ウォークモード' },
  walk_today:          { en: 'Today',            es: 'Hoy',             fr: "Aujourd'hui",    pt: 'Hoje',            ja: '今日' },
  walk_this_walk:      { en: 'This walk',        es: 'Esta caminata',   fr: 'Cette marche',   pt: 'Esta caminhada',  ja: 'この歩行' },
  walk_points_this:    { en: 'Points this walk', es: 'Puntos en esta caminata', fr: 'Points cette marche', pt: 'Pontos nesta caminhada', ja: 'この歩行のポイント' },
  walk_goal_reached:   { en: 'Goal reached!',    es: '¡Meta alcanzada!', fr: 'Objectif atteint !', pt: 'Meta atingida!', ja: '目標達成！' },
  walk_goal_pct:       { en: '{pct}% of {goal}', es: '{pct}% de {goal}', fr: '{pct}% de {goal}', pt: '{pct}% de {goal}', ja: '{goal}の{pct}%' },
  walk_start:          { en: 'Start Walking',    es: 'Empezar a caminar', fr: 'Démarrer la marche', pt: 'Começar a caminhar', ja: '歩き始める' },
  walk_end:            { en: 'End Walk',         es: 'Terminar caminata', fr: 'Terminer la marche', pt: 'Terminar caminhada', ja: '歩行を終了' },
  walk_counting:       { en: 'Counting your steps…', es: 'Contando tus pasos…', fr: 'Comptage des pas…', pt: 'Contando seus passos…', ja: 'ステップをカウント中…' },
  walk_waiting_sensor: { en: 'Waiting for the motion sensor…', es: 'Esperando el sensor de movimiento…', fr: "En attente du capteur de mouvement…", pt: 'Aguardando o sensor de movimento…', ja: 'モーションセンサーを待っています…' },
  walk_nice:           { en: 'Nice walk! {n} steps saved.', es: '¡Buena caminata! {n} pasos guardados.', fr: 'Belle marche ! {n} pas sauvegardés.', pt: 'Boa caminhada! {n} passos salvos.', ja: 'ナイスウォーク！{n}歩保存しました。' },
  walk_ended:          { en: 'Walk ended.',      es: 'Caminata terminada.', fr: 'Marche terminée.', pt: 'Caminhada encerrada.', ja: '歩行が終了しました。' },
  walk_hint:           { en: 'Keep Wanderling open with your phone in your hand or pocket. Steps are counted from the motion sensor and saved every 30 seconds.', es: 'Mantén Wanderling abierto con el teléfono en la mano o el bolsillo. Los pasos se cuentan con el sensor de movimiento y se guardan cada 30 segundos.', fr: "Garde Wanderling ouvert, téléphone en main ou en poche. Les pas sont comptés par le capteur de mouvement et sauvegardés toutes les 30 secondes.", pt: 'Mantenha o Wanderling aberto com o telefone na mão ou no bolso. Os passos são contados pelo sensor de movimento e salvos a cada 30 segundos.', ja: 'Wanderlingを開いたまま、スマートフォンを手またはポケットに。ステップはモーションセンサーでカウントされ、30秒ごとに保存されます。' },
  walk_demo_add:       { en: 'DEMO: +1,000 steps', es: 'DEMO: +1.000 pasos', fr: 'DÉMO : +1 000 pas', pt: 'DEMO: +1.000 passos', ja: 'デモ：+1,000歩' },

  // ── Store screen ────────────────────────────────────────────────────────────
  store_title:          { en: 'Store',         es: 'Tienda',        fr: 'Boutique',      pt: 'Loja',          ja: 'ストア' },
  store_diamonds:       { en: 'Diamonds',      es: 'Diamantes',     fr: 'Diamants',      pt: 'Diamantes',     ja: 'ダイヤモンド' },
  store_wardrobe:       { en: 'Wardrobe',      es: 'Guardarropa',   fr: 'Garde-robe',    pt: 'Guarda-roupa',  ja: 'ワードローブ' },
  store_beasts:         { en: 'Beasts',        es: 'Bestias',       fr: 'Bêtes',         pt: 'Criaturas',     ja: 'ビースト' },
  store_cat_accessories:{ en: 'Accessories',   es: 'Accesorios',    fr: 'Accessoires',   pt: 'Acessórios',    ja: 'アクセサリー' },
  store_cat_backgrounds:{ en: 'Backgrounds',   es: 'Fondos',        fr: 'Arrière-plans', pt: 'Planos de fundo',ja: '背景' },
  store_cat_creatures:  { en: 'Creatures',     es: 'Criaturas',     fr: 'Créatures',     pt: 'Criaturas',     ja: 'クリーチャー' },
  store_creatures_soon: { en: '🐉 Creature unlocks coming soon!', es: '🐉 ¡Desbloqueos de criaturas próximamente!', fr: '🐉 Déblocages de créatures bientôt disponibles !', pt: '🐉 Desbloqueios de criaturas em breve!', ja: '🐉 クリーチャー解放は近日公開！' },
  store_owned:          { en: 'Owned',         es: 'Obtenido',      fr: 'Possédé',       pt: 'Obtido',        ja: '所持済み' },
  store_in_wardrobe:    { en: 'In your wardrobe', es: 'En tu guardarropa', fr: 'Dans ta garde-robe', pt: 'No seu guarda-roupa', ja: 'ワードローブに追加済み' },
  store_buy:            { en: 'Buy',           es: 'Comprar',       fr: 'Acheter',       pt: 'Comprar',       ja: '購入' },
  store_need:           { en: 'Need {n}',      es: 'Necesitas {n}', fr: '{n} manquants', pt: 'Faltam {n}',    ja: '{n}不足' },
  store_nothing:        { en: 'Nothing here yet.', es: 'Nada aquí aún.', fr: 'Rien ici pour le moment.', pt: 'Nada aqui ainda.', ja: 'まだありません。' },
  store_loading:        { en: 'Loading…',      es: 'Cargando…',     fr: 'Chargement…',   pt: 'Carregando…',   ja: '読み込み中…' },
  store_diamond_balance:{ en: 'Your diamond balance', es: 'Tu saldo de diamantes', fr: 'Ton solde en diamants', pt: 'Seu saldo de diamantes', ja: 'ダイヤモンド残高' },
  store_diamond_desc:   { en: 'Use diamonds for special offers and future upgrades. This demo purchase adds diamonds instantly.', es: 'Usa diamantes para ofertas especiales y mejoras futuras. Esta compra de demostración añade diamantes al instante.', fr: 'Utilise les diamants pour des offres spéciales et des améliorations futures. Cet achat de démonstration ajoute des diamants instantanément.', pt: 'Use diamantes para ofertas especiais e melhorias futuras. Esta compra de demonstração adiciona diamantes instantaneamente.', ja: '特別オファーと将来のアップグレードにダイヤモンドを使用。このデモ購入は即座にダイヤモンドを追加します。' },
  store_add_diamonds:   { en: 'Add diamonds',  es: 'Agregar diamantes', fr: 'Ajouter des diamants', pt: 'Adicionar diamantes', ja: 'ダイヤモンドを追加' },
  store_best_value:     { en: 'Best value',    es: 'Mejor valor',   fr: 'Meilleur prix', pt: 'Melhor custo-benefício', ja: 'お得' },
  store_diamonds_added: { en: '{n} diamonds added to your wallet!', es: '¡{n} diamantes añadidos a tu cartera!', fr: '{n} diamants ajoutés à ton portefeuille !', pt: '{n} diamantes adicionados à sua carteira!', ja: '{n}個のダイヤモンドがウォレットに追加されました！' },
  store_bought_item:    { en: '{name} is yours! Find it in your Wardrobe.', es: '¡{name} es tuyo! Encuéntralo en tu Guardarropa.', fr: '{name} est à toi ! Retrouve-le dans ta Garde-robe.', pt: '{name} é seu! Encontre-o no seu Guarda-roupa.', ja: '{name}があなたのものになりました！ワードローブで確認してください。' },
  store_wardrobe_empty: { en: 'Your wardrobe is empty. Buy something in the Store!', es: 'Tu guardarropa está vacío. ¡Compra algo en la Tienda!', fr: 'Ta garde-robe est vide. Achète quelque chose dans la Boutique !', pt: 'Seu guarda-roupa está vazio. Compre algo na Loja!', ja: 'ワードローブが空です。ストアで何か購入してください！' },
  store_wearing:        { en: 'Wearing',       es: 'Usando',        fr: 'Porté',         pt: 'Usando',        ja: '着用中' },
  store_tap_to_wear:    { en: 'Tap to wear',   es: 'Toca para usar', fr: 'Appuie pour porter', pt: 'Toque para usar', ja: 'タップして着用' },
  store_with_beasts:    { en: 'With your beasts', es: 'Con tus bestias', fr: 'Avec tes bêtes', pt: 'Com suas criaturas', ja: 'ビーストと一緒に' },
  store_walk_with:      { en: 'Tap to walk with', es: 'Toca para caminar con', fr: 'Appuie pour marcher avec', pt: 'Toque para caminhar com', ja: 'タップして一緒に歩く' },
  store_walking_you:    { en: 'Walking with you', es: 'Caminando contigo', fr: 'Marche avec toi', pt: 'Caminhando com você', ja: 'あなたと歩いています' },
  store_buy_egg_hint:   { en: 'Buy an egg in the Store to raise another beast.', es: 'Compra un huevo en la Tienda para criar otra bestia.', fr: "Achète un œuf dans la Boutique pour élever une autre bête.", pt: 'Compre um ovo na Loja para criar outra criatura.', ja: 'ストアで卵を購入してもう一匹育てましょう。' },

  // ── Battle screen ──────────────────────────────────────────────────────────
  battle_title:          { en: 'Battle',      es: 'Batalla',      fr: 'Combat',      pt: 'Batalha',    ja: 'バトル' },
  battle_friends:        { en: 'Friends',     es: 'Amigos',       fr: 'Amis',        pt: 'Amigos',     ja: 'フレンド' },
  battle_everyone:       { en: 'Everyone',    es: 'Todos',        fr: 'Tout le monde', pt: 'Todos',    ja: 'みんな' },
  battle_ranks:          { en: 'Ranks',       es: 'Clasificación', fr: 'Classement', pt: 'Rankings',   ja: 'ランキング' },
  battle_add_friend:     { en: 'Add a friend by username', es: 'Añadir amigo por nombre de usuario', fr: "Ajouter un ami par nom d'utilisateur", pt: 'Adicionar amigo por nome de usuário', ja: 'ユーザー名で友達を追加' },
  battle_add_btn:        { en: 'Add',         es: 'Añadir',       fr: 'Ajouter',     pt: 'Adicionar',  ja: '追加' },
  battle_remove:         { en: 'Remove',      es: 'Eliminar',     fr: 'Supprimer',   pt: 'Remover',    ja: '削除' },
  battle_btn:            { en: 'Battle',      es: 'Batallar',     fr: 'Combattre',   pt: 'Batalhar',   ja: 'バトル' },
  battle_loading_friends:{ en: 'Loading friends…', es: 'Cargando amigos…', fr: 'Chargement des amis…', pt: 'Carregando amigos…', ja: 'フレンドを読み込み中…' },
  battle_no_friends:     { en: 'No friends yet! Add one above to battle and race them — try mira, theo or ana.', es: '¡Sin amigos todavía! Añade uno para batallar — prueba con mira, theo o ana.', fr: 'Pas encore d\'amis ! Ajoute-en un pour combattre — essaie mira, theo ou ana.', pt: 'Sem amigos ainda! Adicione um para batalhar — tente mira, theo ou ana.', ja: 'フレンドがいません！上でフレンドを追加してバトルしましょう — mira、theo、anaを試してください。' },
  battle_loading_opponents: { en: 'Looking for challengers…', es: 'Buscando contrincantes…', fr: 'Recherche de challengers…', pt: 'Procurando desafiantes…', ja: 'チャレンジャーを検索中…' },
  battle_no_opponents:   { en: 'No other buddies yet. Invite someone to sign up!', es: 'Aún no hay otros compañeros. ¡Invita a alguien!', fr: "Pas encore d'autres compagnons. Invite quelqu'un à s'inscrire !", pt: 'Nenhum outro companheiro ainda. Convide alguém para se registrar!', ja: '他のバディがいません。誰かを招待してください！' },
  battle_friend_tag:     { en: 'Friend',      es: 'Amigo',        fr: 'Ami',         pt: 'Amigo',      ja: 'フレンド' },
  battle_friends_added:  { en: 'You and {name} are now friends!', es: 'Tú y {name} ahora son amigos.', fr: 'Toi et {name} êtes maintenant amis !', pt: 'Você e {name} agora são amigos!', ja: 'あなたと{name}がフレンドになりました！' },
  battle_tallying:       { en: 'Tallying scores…', es: 'Calculando puntuaciones…', fr: 'Calcul des scores…', pt: 'Calculando pontuações…', ja: 'スコアを集計中…' },
  battle_add_friends_hint:{ en: 'Add friends to see how you stack up against them.', es: 'Añade amigos para compararte con ellos.', fr: 'Ajoute des amis pour te comparer à eux.', pt: 'Adicione amigos para se comparar com eles.', ja: 'フレンドを追加して比較しましょう。' },
  battle_board_steps:    { en: 'Steps',       es: 'Pasos',        fr: 'Pas',         pt: 'Passos',     ja: 'ステップ' },
  battle_board_wins:     { en: 'Wins',        es: 'Victorias',    fr: 'Victoires',   pt: 'Vitórias',   ja: '勝利' },
  battle_board_level:    { en: 'Level',       es: 'Nivel',        fr: 'Niveau',      pt: 'Nível',      ja: 'レベル' },
  battle_scope_friends:  { en: 'Friends',     es: 'Amigos',       fr: 'Amis',        pt: 'Amigos',     ja: 'フレンド' },
  battle_scope_all:      { en: 'Everyone',    es: 'Todos',        fr: 'Tout le monde', pt: 'Todos',    ja: 'みんな' },
  battle_hint:           { en: '{name} has {atk} attack and {eva} evasion. Win a battle to earn 5 bonus Stride Points.', es: '{name} tiene {atk} de ataque y {eva} de evasión. Gana una batalla para ganar 5 Stride Points extra.', fr: '{name} a {atk} en attaque et {eva} en évasion. Remporte un combat pour gagner 5 Stride Points bonus.', pt: '{name} tem {atk} de ataque e {eva} de evasão. Vença uma batalha para ganhar 5 Stride Points bônus.', ja: '{name}の攻撃は{atk}、回避は{eva}です。バトルに勝って5ストライドポイントを獲得しましょう。' },
  battle_round:          { en: 'Round {n} of 5', es: 'Ronda {n} de 5', fr: 'Round {n} sur 5', pt: 'Rodada {n} de 5', ja: 'ラウンド{n}/5' },
  battle_over:           { en: 'Battle over',  es: 'Batalla terminada', fr: 'Combat terminé', pt: 'Batalha encerrada', ja: 'バトル終了' },
  battle_you:            { en: 'You',          es: 'Tú',           fr: 'Toi',         pt: 'Você',       ja: 'あなた' },
  battle_skip:           { en: 'Skip',         es: 'Saltar',       fr: 'Passer',      pt: 'Pular',      ja: 'スキップ' },
  battle_done:           { en: 'Done',         es: 'Listo',        fr: 'Terminé',     pt: 'Concluído',  ja: '完了' },
  battle_result_win:     { en: 'You win!',     es: '¡Ganaste!',    fr: 'Tu gagnes !', pt: 'Você venceu!',ja: '勝利！' },
  battle_result_loss:    { en: 'You lost',     es: 'Perdiste',     fr: 'Tu as perdu', pt: 'Você perdeu', ja: '敗北' },
  battle_result_draw:    { en: "It's a draw!", es: '¡Es un empate!', fr: 'Match nul !', pt: 'Empate!',  ja: '引き分け！' },
  battle_detail_win:     { en: '+5 Stride Points', es: '+5 Stride Points', fr: '+5 Stride Points', pt: '+5 Stride Points', ja: '+5ストライドポイント' },
  battle_detail_loss:    { en: 'Train up and try again!', es: '¡Entrena y vuelve a intentarlo!', fr: 'Entraîne-toi et réessaie !', pt: 'Treine e tente novamente!', ja: '鍛えてまた挑戦しましょう！' },
  battle_detail_draw:    { en: 'So evenly matched.', es: 'Están muy igualados.', fr: 'Tellement équilibrés.', pt: 'Tão equilibrados.', ja: 'とても均衡しています。' },
  battle_fallback_win:   { en: "We did it! All those walks paid off!", es: '¡Lo logramos! ¡Todas esas caminatas valieron la pena!', fr: "On l'a fait ! Toutes ces marches ont payé !", pt: 'Conseguimos! Todas essas caminhadas valeram a pena!', ja: 'やりました！全ての歩行が実を結びました！' },
  battle_fallback_loss:  { en: "We'll get them next time. Let's train!", es: 'Los alcanzaremos la próxima vez. ¡Entrenemos!', fr: "On les aura la prochaine fois. Entraînons-nous !", pt: 'Pegaremos da próxima vez. Vamos treinar!', ja: '次は勝ちます。鍛えましょう！' },
  battle_fallback_draw:  { en: "So close! One more walk and we win.", es: '¡Tan cerca! Una caminata más y ganamos.', fr: 'Si proche ! Encore une marche et on gagne.', pt: 'Tão perto! Mais uma caminhada e vencemos.', ja: 'もう少しでした！あと一歩で勝利です。' },

  // ── Stats screen ────────────────────────────────────────────────────────────
  stats_title:       { en: 'Stats',          es: 'Estadísticas',  fr: 'Stats',          pt: 'Estatísticas',  ja: '統計' },
  stats_loading:     { en: 'Crunching your steps…', es: 'Calculando tus pasos…', fr: 'Calcul de tes pas…', pt: 'Calculando seus passos…', ja: 'ステップを集計中…' },
  stats_today:       { en: 'Today',          es: 'Hoy',           fr: "Aujourd'hui",    pt: 'Hoje',          ja: '今日' },
  stats_streak:      { en: 'Current streak', es: 'Racha actual',  fr: 'Série actuelle', pt: 'Sequência atual', ja: '現在のストリーク' },
  stats_streak_day:  { en: 'day hitting your goal', es: 'día alcanzando tu meta', fr: 'jour à atteindre ton objectif', pt: 'dia atingindo sua meta', ja: '目標達成日数' },
  stats_streak_days: { en: 'days hitting your goal', es: 'días alcanzando tu meta', fr: 'jours à atteindre ton objectif', pt: 'dias atingindo sua meta', ja: '目標達成日数' },
  stats_best_day:    { en: 'Best day',       es: 'Mejor día',     fr: 'Meilleur jour',  pt: 'Melhor dia',    ja: '最高の日' },
  stats_no_walks:    { en: 'No walks yet',   es: 'Sin caminatas aún', fr: 'Pas encore de marches', pt: 'Sem caminhadas ainda', ja: 'まだ歩行なし' },
  stats_total_dist:  { en: 'Total distance', es: 'Distancia total', fr: 'Distance totale', pt: 'Distância total', ja: '総距離' },
  stats_total_steps: { en: '{n} steps all time', es: '{n} pasos en total', fr: '{n} pas au total', pt: '{n} passos no total', ja: '合計{n}歩' },
  stats_co2:         { en: 'CO₂ saved',      es: 'CO₂ ahorrado',  fr: 'CO₂ économisé',  pt: 'CO₂ economizado', ja: 'CO₂削減' },
  stats_co2_detail:  { en: 'vs driving the same distance', es: 'vs. manejar la misma distancia', fr: 'vs conduire la même distance', pt: 'vs dirigir a mesma distância', ja: '同じ距離を運転した場合比' },
  stats_last7:       { en: 'Last 7 days',    es: 'Últimos 7 días', fr: '7 derniers jours', pt: 'Últimos 7 dias', ja: '過去7日間' },
  stats_last30:      { en: 'Last 30 days',   es: 'Últimos 30 días', fr: '30 derniers jours', pt: 'Últimos 30 dias', ja: '過去30日間' },
  stats_touch_chart: { en: 'Touch the chart to see a day', es: 'Toca el gráfico para ver un día', fr: 'Touche le graphique pour voir un jour', pt: 'Toque no gráfico para ver um dia', ja: 'グラフをタッチして日付を確認' },
  stats_goal_pct:    { en: '{pct}% of your {goal}-step goal', es: '{pct}% de tu meta de {goal} pasos', fr: '{pct}% de ton objectif de {goal} pas', pt: '{pct}% da sua meta de {goal} passos', ja: '{goal}歩目標の{pct}%' },

  // ── Profile sheet ──────────────────────────────────────────────────────────
  profile_title:        { en: 'Profile',          es: 'Perfil',            fr: 'Profil',           pt: 'Perfil',           ja: 'プロフィール' },
  profile_close:        { en: 'Close',             es: 'Cerrar',            fr: 'Fermer',           pt: 'Fechar',           ja: '閉じる' },
  profile_wins:         { en: 'Wins',              es: 'Victorias',         fr: 'Victoires',        pt: 'Vitórias',         ja: '勝利' },
  profile_losses:       { en: 'Losses',            es: 'Derrotas',          fr: 'Défaites',         pt: 'Derrotas',         ja: '敗北' },
  profile_draws:        { en: 'Draws',             es: 'Empates',           fr: 'Matchs nuls',      pt: 'Empates',          ja: '引き分け' },
  profile_distance_units:{ en: 'Distance units',   es: 'Unidades de distancia', fr: 'Unités de distance', pt: 'Unidades de distância', ja: '距離の単位' },
  profile_km:           { en: 'Kilometres',        es: 'Kilómetros',        fr: 'Kilomètres',       pt: 'Quilómetros',      ja: 'キロメートル' },
  profile_mi:           { en: 'Miles',             es: 'Millas',            fr: 'Miles',            pt: 'Milhas',           ja: 'マイル' },
  profile_language:     { en: 'Language',          es: 'Idioma',            fr: 'Langue',           pt: 'Idioma',           ja: '言語' },
  profile_buddy_name:   { en: 'Buddy name',        es: 'Nombre del compañero', fr: 'Nom du compagnon', pt: 'Nome do companheiro', ja: 'バディ名' },
  profile_daily_goal:   { en: 'Daily step goal',   es: 'Meta diaria de pasos', fr: 'Objectif de pas quotidien', pt: 'Meta diária de passos', ja: '日次ステップ目標' },
  profile_personality:  { en: 'Personality',       es: 'Personalidad',      fr: 'Personnalité',     pt: 'Personalidade',    ja: 'パーソナリティ' },
  profile_keep_current: { en: 'Keep current',      es: 'Mantener actual',   fr: 'Garder l\'actuel', pt: 'Manter atual',     ja: '現在のまま' },
  profile_surprise:     { en: 'Surprise me (new random one)', es: 'Sorpréndeme (nueva aleatoria)', fr: 'Surprise (nouvelle aléatoire)', pt: 'Me surpreenda (nova aleatória)', ja: 'サプライズ（新しいランダム）' },
  profile_save:         { en: 'Save',              es: 'Guardar',           fr: 'Sauvegarder',      pt: 'Salvar',           ja: '保存' },
  profile_saved:        { en: 'Saved!',            es: '¡Guardado!',        fr: 'Sauvegardé !',     pt: 'Salvo!',           ja: '保存しました！' },
  profile_recent_battles:{ en: 'Recent battles',   es: 'Batallas recientes', fr: 'Combats récents', pt: 'Batalhas recentes', ja: '最近のバトル' },
  profile_loading:      { en: 'Loading…',          es: 'Cargando…',         fr: 'Chargement…',      pt: 'Carregando…',      ja: '読み込み中…' },
  profile_no_battles:   { en: 'No battles yet. Pick a fight in the Battle tab!', es: 'Sin batallas aún. ¡Pelea en la pestaña de Batalla!', fr: "Pas encore de combat. Lance-toi dans l'onglet Combat !", pt: 'Sem batalhas ainda. Escolha uma luta na aba Batalha!', ja: 'バトルはまだありません。バトルタブで戦いましょう！' },
  profile_battles_error:{ en: "Couldn't load battles.", es: 'No se pudieron cargar las batallas.', fr: 'Impossible de charger les combats.', pt: 'Não foi possível carregar as batalhas.', ja: 'バトルを読み込めませんでした。' },
  profile_sign_out:     { en: 'Sign out',          es: 'Cerrar sesión',     fr: 'Se déconnecter',   pt: 'Sair',             ja: 'サインアウト' },
};

/** Returns the active language code ('en', 'es', etc.) */
export function lang() {
  try {
    const stored = localStorage.getItem(LANG_KEY);
    return LANGUAGES.some((l) => l.id === stored) ? stored : 'en';
  } catch {
    return 'en';
  }
}

/** Persists a new language choice and dispatches a 'langchange' event. */
export function setLang(code) {
  try {
    localStorage.setItem(LANG_KEY, code);
  } catch {}
  window.dispatchEvent(new Event('langchange'));
}

/**
 * Translates a key into the active language.
 * Supports simple template substitution: t('key', { n: 42 }) replaces {n}.
 */
const ALL_STRINGS = { ...STRINGS, ...EXTRA };
export function t(key, vars) {
  const entry = ALL_STRINGS[key];
  if (!entry) return key; // fallback: return the key itself
  let str = entry[lang()] ?? entry.en ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) str = str.replaceAll(`{${k}}`, v);
  }
  return str;
}
