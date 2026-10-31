/* FiveWeb's same-origin UI dictionary. Operator content is never translated. */
(function (root) {
  'use strict';
  const pairs = [
    ['FiveWeb · Sunucular', 'FiveWeb · Servers'],
    ['İçeriğe geç', 'Skip to content'], ['FiveWeb ana sayfa', 'FiveWeb home'],
    ['Sunucu tarayıcısı', 'Server browser'], ['Ana gezinme', 'Main navigation'],
    ['Sunucular', 'Servers'], ['Kaynaklar', 'Resources'],
    ['Deneysel · 128 oyuncu', 'Experimental · 128 players'],
    ['Ortak dünya · beta', 'Shared world · beta'],
    ["Ortak Dünya'da oyuncular, NPC'ler ve araçlar aynı dünyada (8 oyuncu, beta). Serbest dolaşım 128 oyuncuya kadar konum paylaşır. Katılmak için bir sunucu seç; karakterinle girersin.", 'In the Shared World players, NPCs and vehicles share one world (8 players, beta). Free roam shares positions for up to 128 players. Pick a server; you join with your character.'],
    ['Ortak dünyaya karakter ekranından girilir.', 'Enter the shared world from the character screen.'],
    ['Ortak dünya sunucusu şu an kapalı.', 'The shared world server is offline right now.'], ['Ortak dünya dolu.', 'The shared world is full.'],
    ['Her sunucu en fazla', 'Each server hosts up to'], ['128 oyuncu', '128 players'],
    ['barındırır. Katılmak için bir sunucu seçin; karakterinle girersin.', 'Choose a server; you join with your character.'],
    ['Yükleniyor…', 'Loading…'], ['Sunucu filtreleri', 'Server filters'],
    ['Sunucu ara', 'Search servers'], ['Sunucu, açıklama veya etiket ara', 'Search servers, descriptions or tags'],
    ['Duruma göre filtrele', 'Filter by status'], ['Tümü', 'All'], ['Açık', 'Open'], ['Dolu', 'Full'],
    ['Yenile', 'Refresh'], ['Sunucu listesi', 'Server list'], ['Bir sunucu seçin', 'Select a server'],
    ['Açıklama, kaynaklar ve katılım bilgisi burada görünür.', 'Description, resources and join details appear here.'],
    ['Seçili sunucu', 'Selected server'], ['Bağlı', 'Connected'], ['Rezerve', 'Reserved'],
    ['Kapasite', 'Capacity'], ['Durum', 'Status'], ['Etiketler', 'Tags'], ['Sesli iletişim', 'Voice chat'],
    ['Takma adınız', 'Your nickname'], ['2–20 karakter.', '2–20 characters.'], ['Katıl', 'Join'],
    ['Uyumluluk:', 'Compatibility:'],
    [". Sunucular FXServer ikili dosyasıyla uyumlu değildir; FiveWeb'in kendi sunucu API'sini kullanır.", '. Servers are not compatible with the FXServer binary; they use FiveWeb’s own server API.'],
    ['Bilmeniz gerekenler', 'What you need to know'],
    ['Liste 15 saniyede bir güncellenir. Boş ve dolu sunucular olduğu gibi görünür.', 'The list updates every 15 seconds. Empty and full servers are shown as they are.'],
    ['Oturum anahtarı yalnızca bu sekmenin oturum deposunda tutulur; adres çubuğunda ya da yerel depoda yer almaz.', 'The session key stays in this tab’s session storage only, never in the address bar or local storage.'],
    ['Sesli iletişim isteğe bağlıdır. Mikrofon yalnızca siz sesli iletişimi açtığınızda istenir; kamera kullanılmaz.', 'Voice is optional. Microphone access is requested only when you enable voice; the camera is never used.'],
    ['Deneysel sürümde yalnızca oyuncu konumları senkronize edilir; tam GTA Online oturumu değildir.', 'This experimental version synchronizes player positions only; it is not a full GTA Online session.'],
    ['Her sunucu kendi kaynak listesini (ad ve sürüm) yayımlar. Bu liste bilgilendirme amaçlıdır; kaynaklar sunucudan tarayıcıya akar, yerel pakete kurulmaz.', 'Each server publishes its resource list (name and version). This list is informational; resources stream from the server to the browser and are not installed into a local package.'],
    ['FiveWeb · Deneysel sunucu tarayıcısı', 'FiveWeb · Experimental server browser'], ['Tek oyunculu', 'Single player'],
    ['Açıklama yok.', 'No description.'], ['Tekrar dene', 'Try again'],
    ['Sunucular yüklenemedi.', 'Could not load servers.'], ['Bağlantıyı kontrol edip yeniden deneyin.', 'Check your connection and try again.'],
    ['Şu an açık sunucu yok.', 'No servers are open right now.'],
    ['Sunucular açıldığında burada görünür. Liste 15 saniyede bir güncellenir.', 'Servers appear here when available. The list updates every 15 seconds.'],
    ['Filtreye uyan sunucu yok.', 'No servers match your filters.'], ['Arama metnini ya da filtreyi değiştirin.', 'Change your search or filter.'],
    ['Bu sunucu için açıklama girilmemiş.', 'No description has been provided for this server.'],
    ['Etiket yok', 'No tags'], ['Kaynak bilgisi yayımlanmamış.', 'No resource information published.'],
    ['Bu sunucu sesli iletişimi destekler. Bu isteğe bağlıdır: mikrofon izni yalnızca siz sesli iletişimi açtığınızda sorulur ve kamera kullanılmaz.', 'This server supports optional voice chat. Microphone permission is requested only when you enable voice; the camera is never used.'],
    ['Bu sunucuda sesli iletişim yok.', 'Voice chat is unavailable on this server.'],
    ['Bu sunucu dolu. Başka bir sunucu seçin.', 'This server is full. Choose another server.'],
    ['Güncellenemedi; son bilinen liste gösteriliyor.', 'Could not refresh; showing the last known list.'],
    ['Sunucu yok', 'No servers'], ['Bağlantı hatası · son liste', 'Connection error · last known list'], ['Bağlantı hatası', 'Connection error'],
    ['Sunucu bulunamadı. Listeyi yenileyin.', 'Server not found. Refresh the list.'],
    ['Sunucu dolu. Başka bir sunucu seçin.', 'Server full. Choose another server.'],
    ['Çok fazla deneme yapıldı. Biraz bekleyin.', 'Too many attempts. Please wait.'],
    ['Önce bir sunucu seçin.', 'Select a server first.'], ['Bu sunucu dolu.', 'This server is full.'],
    ['Takma ad 2–20 karakter olmalı.', 'Nickname must be 2–20 characters.'],
    ['Sunucudan geçersiz yanıt alındı.', 'Invalid response from the server.'], ['Başlatıcı hazırlanıyor…', 'Preparing launcher…'],
    ['Sunucu yanıt vermedi. Tekrar deneyin.', 'Server did not respond. Try again.'],
    ['Katılım başarısız. Tekrar deneyin.', 'Could not join. Try again.'],
    ['Bu kaynaktan istek kabul edilmiyor.', 'Requests from this origin are not allowed.'],
    ['Takma ad 2-20 karakter olmalı (harf, rakam, boşluk, - _ .).', 'Nickname must be 2–20 characters (letters, numbers, spaces, - _ .).'],
    ['Geçersiz JSON.', 'Invalid JSON.'], ['Gövde application/json olmalı.', 'The request body must be application/json.'],
    ['Gövde bir JSON nesnesi olmalı.', 'The request body must be a JSON object.'],
    ['İzin verilmeyen yöntem.', 'Method not allowed.'], ['Bulunamadı.', 'Not found.'],
    ['FiveWeb deneysel sunucu tarayıcısı', 'FiveWeb experimental server browser'],
    ['{connected} / {capacity} bağlı · rezerve {reserved}', '{connected} / {capacity} connected · reserved {reserved}'],
    ['{count} oyuncu', '{count} players'], ['Deneysel · {count} oyuncu', 'Experimental · {count} players'],
    ['{count} sunucu', '{count} servers'], ['{count} · güncellendi {time}', '{count} · updated {time}'],
    ['Katılım sırasında bir hata oluştu ({status}).', 'An error occurred while joining ({status}).'],
    ['{name} sunucusuna katılınıyor…', 'Joining {name}…'],
    ['Lobi oturumu bulunamadı veya süresi doldu. Lobiler sayfasından tekrar katılın.', 'Lobby session missing or expired. Join again from the server browser.'],
    ['Lobi oturumunun süresi doldu. Lobiler sayfasından tekrar katılın.', 'Lobby session expired. Join again from the server browser.'],
    ['Çok oyunculu mod bu tarayıcıda başlatılamadı. Lobiler sayfasından tekrar katılın.', 'Multiplayer could not start in this browser. Join again from the server browser.'],
    ["Lobi: {name} — Başlat'a basarak oyuna girin.", 'Lobby: {name} — Press Start to enter the game.'],
    ['Sesli sohbet', 'Voice chat'], ['Sesi kapat', 'Leave voice'], ['Sese katıl', 'Join voice'],
    ['Mikrofonu aç', 'Unmute microphone'], ['Mikrofonu kapat', 'Mute microphone'],
    ['Bağlanıyor…', 'Connecting…'], ['Bağlandı', 'Connected'], ['Bağlantı kesildi, yeniden deneniyor', 'Disconnected, retrying'], ['Bağlantı kurulamadı', 'Could not connect'],
    ['Doğrudan bağlantı: sunucuda TURN yok. Ağınız (NAT) izin vermezse ses kurulamaz.', 'Direct connection: no TURN on this server. Voice cannot connect if your network (NAT) does not allow it.'],
    ['Mikrofon izni verilmedi. Tarayıcı ayarlarından izin verip tekrar deneyin.', 'Microphone permission denied. Allow it in browser settings and try again.'],
    ['Mikrofon bulunamadı.', 'No microphone found.'], ['Mikrofon başka bir uygulama tarafından kullanılıyor.', 'The microphone is in use by another application.'], ['Mikrofon açılamadı.', 'Could not open microphone.'],
    ['Bu tarayıcı sesli sohbeti desteklemiyor (WebRTC yok).', 'This browser does not support voice chat (WebRTC unavailable).'],
    ['Mikrofon isteniyor…', 'Requesting microphone…'], ['Sesli sohbet kapalı.', 'Voice chat is off.'],
    ['Sesli sohbet kapalı. Karşı oyuncu bekleniyor.', 'Voice chat is off. Waiting for the other player.'],
    ['Mikrofon açık. Karşı oyuncu bekleniyor.', 'Microphone on. Waiting for the other player.'],
    ['Ses: ', 'Voice: '], ['Ses: karşı oyuncu bekleniyor', 'Voice: waiting for the other player'],
    ['Genel TURN seçildi (birincil).', 'Public TURN selected (primary).'],
    ['Yedek TURN seçildi; genel TURN kullanılamadı.', 'Own backup TURN selected; public TURN unavailable.'],
    ['Bağlantı yapılandırması alınamadı; doğrudan bağlantı denenecek.', 'Could not get connection configuration; trying a direct connection.'],
    ['Ses anlaşması başarısız oldu.', 'Voice negotiation failed.'],
    ['Karşı tarafın sesini duymak için "Sese katıl" düğmesine basın.', 'Press "Join voice" to hear the other player.'],
    ['Yedek TURN seçildi; ICE yeniden başlatılıyor.', 'Own backup TURN selected; restarting ICE.'],
    ['Yedek TURN yeniden başlatılamadı; ses bağlantısı başarısız.', 'Could not restart own backup TURN; voice connection failed.'],
    ['Genel ve yedek TURN ile ses bağlantısı başarısız.', 'Voice connection failed with public and own backup TURN.'],
    ['Bir ağ adayı reddedildi.', 'A network candidate was rejected.'], ['Ses sinyali işlenemedi.', 'Could not process voice signal.'],
    ['Çok oyunculu: {status}\nOyuncular: {count}', 'Multiplayer: {status}\nPlayers: {count}'],
    ['Başlatılıyor', 'Starting'], ['Bağlanıyor', 'Connecting'], ['Odaya katılınıyor', 'Joining room'],
    ['Diğer oyuncu ayrıldı', 'Other player left'], ['Diğer oyuncu katıldı; kopyası oluşturuluyor', 'Other player joined; spawning replica'],
    ['Diğer oyuncunun kopyası etkin', 'Other player replica active'], ['Katıldınız; diğer oyuncu mevcut', 'Joined; other player present'],
    ['Katıldınız; diğer oyuncu bekleniyor', 'Joined; waiting for the other player'], ['Diğer oyuncu katıldı', 'Other player joined'],
    ['Diğer oyuncu ayrıldı; kopyası kaldırılıyor', 'Other player left; removing replica'], ['Kapalı', 'Closed'], ['Sayfadan ayrıldınız', 'Left the page'],
    ['Oyun başladı; diğer oyuncu mevcut', 'Playing; other player present'], ['Oyun başladı; diğer oyuncu bekleniyor', 'Playing; waiting for the other player'],
    ['Kopya oluşturma reddedildi (durum {status})', 'Replica spawn refused (status {status})'], ['Kopya hareketi reddedildi (durum {status})', 'Replica move refused (status {status})'],
    ['Bağlantı kapandı ({code})', 'Connection closed ({code})'], ['Başlatılamadı: {reason}', 'Not started: {reason}'],
    ['Yerel konum alınamıyor: {reason}', 'Local pose unavailable: {reason}'], ['Aktarıcı protokolü uyumsuz', 'Relay protocol mismatch'],
    ['Bekleyen çok oyunculu başlatma yok', 'No multiplayer launch pending'], ['Çok oyunculu başlatma verisi okunamıyor', 'Multiplayer launch data is unreadable'],
    ['Aktarıcı adresi geçersiz', 'Relay address is invalid'], ['Aktarıcı oyun sitesiyle aynı kaynaktan olmalı', 'Relay must be on the game website origin'],
    ['HTTPS sayfası WSS aktarıcı gerektirir', 'An HTTPS page requires a WSS relay'], ['Oda adı geçersiz', 'Room name is invalid'], ['Katılım anahtarı geçersiz', 'Join key is invalid'],
    ['Sunucu bilgisi eksik', 'host info missing'], ['İstek kullanılamıyor', 'fetch unavailable'],
    ['Dil', 'Language'], ['Otomatik (tarayıcı)', 'Automatic (browser)'],
    ['Tuşlar', 'Keys'], ['Harita', 'Map'], ['Kapat', 'Close'], ['Tuş kombinasyonları', 'Key combinations'],
    ['Arayüzü gizle', 'Hide UI'], ['Arayüzü göster', 'Show UI'], ['Arayüzü gizle / göster', 'Hide / show UI'],
    ['Oyuncu haritası', 'Player map'], ['Harita: {count} oyuncu konumu', 'Map: {count} player positions'],
    ['Sen · {x}, {y}', 'You · {x}, {y}'], ['Oyuncu {n} · {where}', 'Player {n} · {where}'], ['konum bekleniyor', 'waiting for position'],
    ['Konum yalnızca çok oyunculu sunucuda görünür.', 'Positions appear only on a multiplayer server.'],
    ['Hareket', 'Movement'], ['Etkileşim', 'Interaction'], ['Uçak ve helikopter', 'Aircraft'], ['Fare', 'Mouse'], ['Sayfa ve FiveWeb', 'Page and FiveWeb'],
    ['İleri / gaz', 'Forward / accelerate'], ['Geri / fren', 'Back / brake'], ['Sol', 'Left'], ['Sağ', 'Right'], ['Koş', 'Sprint'],
    ['Zıpla / el freni', 'Jump / handbrake'], ['Eğil / gizlen', 'Crouch / stealth'], ['Araca bin / in', 'Enter / exit vehicle'],
    ['Etkileşim / korna', 'Interact / horn'], ['Şarjör değiştir', 'Reload'], ['Siper', 'Cover'], ['Arkaya bak', 'Look behind'], ['Farlar', 'Headlights'],
    ['Etkileşim menüsü', 'Interaction menu'], ['Telefon', 'Phone'], ['Silah çarkı', 'Weapon wheel'], ['Duraklat / harita', 'Pause / map'], ['Onayla', 'Confirm'],
    ['Burun aşağı (I)', 'Pitch down (I)'], ['Burun yukarı (K)', 'Pitch up (K)'], ['Sola yat (J)', 'Roll left (J)'], ['Sağa yat (L)', 'Roll right (L)'],
    ['Hedef sol (U)', 'Target left (U)'], ['Hedef sağ (O)', 'Target right (O)'],
    ['Sol tık', 'Left click'], ['Sağ tık', 'Right click'], ['Tekerlek', 'Wheel'], ['Ateş et', 'Fire'], ['Nişan al', 'Aim'], ['Silah değiştir', 'Switch weapon'],
    ['Oyuna tıkla', 'Click the game'], ['Fareyi yakala', 'Capture the mouse'], ['Fareyi bırak', 'Release the mouse'], ['Klavye modunu değiştir', 'Switch keyboard mode'],
    ['FPS göstergesi', 'FPS counter'], ['Tam ekran', 'Fullscreen'], ['Atanmamış', 'Unbound'], ['Boşluk', 'Space'],
    ['{label} (varsayılan: {key})', '{label} (default: {key})'],
    ['Karakter', 'Character'], ['Kullanıcı adı', 'Username'], ['Şifre', 'Password'], ['Kayıt ol', 'Sign up'], ['Giriş yap', 'Log in'],
    ['Hesabın var mı? Giriş yap', 'Have an account? Log in'], ['Hesabın yok mu? Kayıt ol', 'No account? Sign up'],
    ['Kullanıcı adı 3-20 karakter; şifre en az 8 karakter.', 'Username 3-20 characters; password at least 8 characters.'],
    ['Karakterlerin ve paran hesabına bağlıdır.', 'Your characters and money belong to your account.'],
    ['Cüzdan', 'Wallet'], ['Banka', 'Bank'], ['Doğum tarihi', 'Date of birth'], ['Uyruk', 'Nationality'], ['Meslek', 'Job'], ['Telefon', 'Phone'], ['Hesap no', 'Account no'],
    ['İşsiz', 'Unemployed'], ['Sil', 'Delete'], ['Silmek için karakterin tam adını yazın: {name}', 'Type the full character name to delete: {name}'],
    ['Erkek', 'Male'], ['Kadın', 'Female'], ['Ad', 'First name'], ['Soyad', 'Last name'], ['Cinsiyet', 'Gender'], ['Karakter oluştur', 'Create character'], ['Yeni karakter', 'New character'],
    ['Başlangıç: $5,000 nakit ve $25,000 banka.', 'Start: $5,000 cash and $25,000 in the bank.'], ['{name} oluşturuldu.', '{name} created.'],
    ['Çıkış', 'Log out'], ['Karakter slotu: {used}/{slots}', 'Character slots: {used}/{slots}'], ['Hesap: {name}', 'Account: {name}'],
    ['Henüz karakterin yok. Çok oyunculu sunuculara girmek için bir karakter oluştur.', 'No characters yet. Create one to join multiplayer servers.'],
    ['Karakter: {name}', 'Character: {name}'], ['Katılmak için giriş yapıp bir karakter seçin.', 'Log in and pick a character to join.'],
    ['İşlem başarısız ({status}).', 'Request failed ({status}).'],
    ['Kullanıcı adı 3-20 karakter olmalı (harf, rakam, _ . -).', 'Username must be 3-20 characters (letters, digits, _ . -).'], ['Şifre 8-72 karakter olmalı.', 'Password must be 8-72 characters.'],
    ['Bu kullanıcı adı alınmış.', 'This username is taken.'], ['Kullanıcı adı veya şifre hatalı.', 'Wrong username or password.'], ['Giriş yapın.', 'Please log in.'],
    ['Karakter slotlarınız dolu.', 'Your character slots are full.'], ['Ad geçersiz.', 'Invalid first name.'], ['Soyad geçersiz.', 'Invalid last name.'], ['Uyruk geçersiz.', 'Invalid nationality.'],
    ['Cinsiyet geçersiz.', 'Invalid gender.'], ['Doğum tarihi geçersiz.', 'Invalid date of birth.'], ['Karakter 18-90 yaş arasında olmalı.', 'Character must be 18-90 years old.'],
    ['Karakter bulunamadı.', 'Character not found.'], ['Silmek için karakterin tam adını yazın.', 'Type the full character name to delete.'], ['Bu karakter zaten oyunda.', 'This character is already in game.'],
    ['Cüzdanda yeterli nakit yok.', 'Not enough cash in the wallet.'], ['Banka bakiyesi yetersiz.', 'Insufficient bank balance.'], ['Alıcı hesap bulunamadı.', 'Recipient account not found.'],
    ['Kendi hesabınıza havale yapamazsınız.', 'You cannot transfer to your own account.'], ['Geçersiz banka işlemi.', 'Invalid bank action.'],
    ['Alıcı hesap numarası FW ile başlayan 12 karakter olmalı.', 'Recipient account number must be 12 characters starting with FW.'],
    ['Banka ve para', 'Bank and money'], ['Banka {amount}', 'Bank {amount}'], ['FiveWeb Bank', 'FiveWeb Bank'], ['Banka için karakterle giriş yapın.', 'Join with a character to use the bank.'],
    ['Tutar', 'Amount'], ['Yatır', 'Deposit'], ['Çek', 'Withdraw'], ['Havale yap', 'Transfer'], ['Alıcı hesap no', 'Recipient account no'], ['Açıklama', 'Note'],
    ['İşlem tamam.', 'Done.'], ['Son işlemler', 'Recent transactions'], ['Nakit', 'Cash'], ['Maaş', 'Paycheck'], ['Başlangıç parası', 'Starter money'],
    ['Bankaya yatırıldı', 'Deposited'], ['Bankadan çekildi', 'Withdrawn'], ['Havale', 'Transfer'],
    ['Çok oyunculu sunuculara karakterinle girersin. Paran, banka hesabın, araçların ve evlerin karakterine bağlıdır.', 'You join multiplayer servers with a character. Money, bank account, vehicles and homes belong to the character.'],
    ['Giriş yap / Kayıt ol', 'Log in / Sign up'], ['Karakter değiştir', 'Switch character'], ['Karakter ekranı', 'Character screen'], ['Katıl: önce karakter ekranı açılır.', 'Join opens the character screen first.'],
    ['KULLANICI ADI', 'USERNAME'], ['ŞİFRE', 'PASSWORD'], ['GİRİŞ', 'LOG IN'], ['GİRİŞ YAP', 'LOG IN'], ['KAYIT OL', 'SIGN UP'], ['KARAKTER', 'CHARACTER'], ['SEÇME', 'SELECT'], ['OYNA', 'PLAY'], ['SİL', 'DELETE'],
    ['İPTAL', 'CANCEL'], ['İSİMLİ KARAKTERİN SİLİNMESİNİ ONAYLIYOR MUSUNUZ?', '— DELETE THIS CHARACTER?'], ['OLUŞTUR', 'CREATE'], ['ERKEK', 'MALE'], ['KADIN', 'FEMALE'], ['AD', 'FIRST NAME'], ['SOYAD', 'LAST NAME'],
    ['UYRUK', 'NATIONALITY'], ['DOĞUM TARİHİ', 'DATE OF BIRTH'], ['( EN FAZLA 20 HARF )', '( MAX 20 LETTERS )'], ['( EN FAZLA 24 HARF )', '( MAX 24 LETTERS )'], ['VAZGEÇ', 'CANCEL'], ['← SUNUCULAR', '← SERVERS'],
    ['ÇIKIŞ', 'LOG OUT'], ['KARAKTER BİLGİLERİ', 'CHARACTER INFO'], ['YÜKLENİYOR', 'LOADING'], ['YAŞ', 'AGE'], ['KARAKTER OLUŞTUR', 'CREATE CHARACTER'], ['MESLEK', 'JOB'], ['CÜZDAN', 'WALLET'], ['BANKA', 'BANK'],
    ['TELEFON NUMARASI', 'PHONE NUMBER'], ['HESAP NUMARASI', 'ACCOUNT NUMBER'],
    ['Oynamak istediğin karakteri seç ya da boş bir slota yeni karakter oluştur. Paran, banka hesabın, araçların ve evlerin karaktere bağlıdır.', 'Pick the character you want to play or create a new one in an empty slot. Money, bank account, vehicles and homes belong to the character.'],
    ['Karakter adı oyunda diğer oyunculara görünür. Başlangıç: $5,000 nakit ve $25,000 banka.', 'Other players see the character name in game. Start: $5,000 cash and $25,000 in the bank.'],
    ['Telefon için karakterle giriş yapın.', 'Join with a character to use the phone.'], ['Telefon: banka, meslek, market, galeri, emlak', 'Phone: bank, jobs, shop, cars, homes'], ['Oyun haritası (oyuncular işaretli)', 'Game map (players marked)'],
    ['Oyun haritası (ESC) bağlı: {count} oyuncu işaretli.', 'Game map (ESC) connected: {count} players marked.'], ['Oyun haritası (ESC) hazır; oyun dünyası yükleniyor.', 'Game map (ESC) ready; the world is loading.'],
    ['Oyun haritasına bağlanılamadı: {error}', 'Could not connect to the game map: {error}'], ['Oyun haritası (ESC) çok oyunculu sunucuda oyuncuları gösterir.', 'The game map (ESC) shows players on a multiplayer server.'],
    ['Market', 'Shop'], ['Galeri', 'Dealership'], ['Emlak', 'Real estate'], ['Envanter', 'Inventory'], ['Rehber', 'Contacts'], ['Şu anki meslek: {job} · maaş {salary} / 10 dk', 'Current job: {job} · pay {salary} / 10 min'],
    ['Maaş {salary} / 10 dk', 'Pay {salary} / 10 min'], ['Mevcut', 'Current'], ['İşe gir', 'Take job'], ['24/7 Market: nakit veya kartla öde.', '24/7 shop: pay cash or card.'], ['Kart', 'Card'], ['Plaka {plate}', 'Plate {plate}'], ['Sat', 'Sell'],
    ['{name} aracını satmak istiyor musunuz?', 'Sell {name}?'], ['Garajım ({count})', 'My garage ({count})'], ['Satın al', 'Buy'], ['Senin', 'Yours'], ['Satıldı', 'Sold'], ['{name} satılsın mı?', 'Sell {name}?'],
    ['Envanter boş. Marketten alışveriş yapabilirsin.', 'Inventory is empty. Visit the shop.'], ['Ver', 'Give'], ['At', 'Drop'], ['Numaram {phone} · Hesap {account}', 'My number {phone} · Account {account}'], ['Şu an oyunda başka oyuncu yok.', 'No other players in game right now.'],
    ['Taksi şoförü', 'Taxi driver'], ['Tır şoförü', 'Truck driver'], ['Tamirci', 'Mechanic'], ['Sağlık görevlisi', 'Paramedic'], ['Polis', 'Police'], ['Emlakçı', 'Realtor'],
    ['Su', 'Water'], ['Sandviç', 'Sandwich'], ['Kahve', 'Coffee'], ['Telsiz', 'Radio'], ['Tamir kiti', 'Repair kit'], ['Benzin bidonu', 'Jerry can'], ['Bandaj', 'Bandage'], ['Maymuncuk', 'Lockpick'],
    ['Gıda', 'Food'], ['Elektronik', 'Electronics'], ['Araç', 'Vehicle'], ['Sağlık', 'Health'], ['Alet', 'Tool'], ['Kompakt', 'Compact'], ['Motosiklet', 'Motorcycle'], ['Spor', 'Sports'], ['Süper', 'Super'],
    ['Meslek bulunamadı.', 'Job not found.'], ['Zaten bu meslektesiniz.', 'You already have this job.'], ['Meslek değiştirmek için biraz bekleyin.', 'Wait a bit before changing jobs.'], ['Ürün bulunamadı.', 'Item not found.'],
    ['Envanterde yer yok.', 'No room in inventory.'], ['Envanterde o kadar yok.', 'Not enough in inventory.'], ['Bu numarada kimse yok.', 'Nobody has this number.'], ['Kendinize veremezsiniz.', 'You cannot give to yourself.'],
    ['Alıcının envanterinde yer yok.', "Recipient's inventory is full."], ['Araç bulunamadı.', 'Vehicle not found.'], ['Garajınız dolu.', 'Your garage is full.'], ['Ev bulunamadı.', 'Home not found.'], ['Bu evin sahibi var.', 'This home is owned.'],
    ['Daha fazla ev alamazsınız.', 'You cannot buy more homes.'], ['Ödeme yöntemi nakit veya banka olmalı.', 'Payment must be cash or bank.'], ['Telefon numarası 555-xxxx biçiminde olmalı.', 'Phone number must look like 555-xxxx.'], ['Geçersiz işlem.', 'Invalid action.'],
    ['oyuncu çevrimiçi', 'players online'], ['sunucu', 'servers'], ['Çevrimiçi oyuncular', 'Players online'], ['Oyunda', 'In game'], ['Katılıyor', 'Joining'],
    ['Şu an kimse oyunda değil. İlk giren sen ol!', 'Nobody is in game right now. Be the first!'],
    ['128 oyunculu serbest dünya', '128-player open world'], ['Karakterinle gir, kazan, harca', 'Join with your character, earn and spend'], ['Tarayıcıda GTA V çok oyunculu', 'GTA V multiplayer in the browser'],
    ['F6 ile telefonu aç: banka, galeri, emlak.', 'Press F6 for the phone: bank, dealership, real estate.'], ['F8 tüm tuşları gösterir.', 'F8 shows every key.'],
    ['F9 arayüzü gizler, ekran görüntüsü için ideal.', 'F9 hides the interface, ideal for screenshots.'], ['Maaşın oyundayken her 10 dakikada bir bankaya yatar.', 'While in game your paycheck reaches the bank every 10 minutes.'],
    ['Diğer oyuncular radarda ve ESC haritasında görünür.', 'Other players appear on the radar and the ESC map.'],
    ['Başlatılıyor…', 'Starting…'], ['Motor indiriliyor ve derleniyor ({0} MB)', 'Downloading and compiling the engine ({0} MB)'], ['Motor indiriliyor ({0} MB)', 'Downloading the engine ({0} MB)'],
    ['Motor derleniyor', 'Compiling the engine'], ['Motor başlatılıyor', 'Starting the engine'], ['Grafikler başlatılıyor', 'Starting graphics'], ['Dünya yükleniyor', 'Loading the world'],
    ['Gölgelendiriciler hazırlanıyor ({0} kaldı)', 'Preparing shaders ({0} left)'], ['Dünya akışı tamamlanıyor', 'Finishing world streaming'], ['Hazır', 'Ready'],
    ['Sunucu meşgul, yeniden deneniyor ({0})', 'The server is busy, retrying ({0})'],
    ['{0} sn güncelleme yok; ilk açılış uzun sürebilir, sekmeyi açık tut.', 'No updates for {0} s; the first launch can take long, keep this tab open.'],
    ['Yükleme sesi: açık', 'Loading sound: on'], ['Yükleme sesi: kapalı', 'Loading sound: off'], ['Başlatıcıya dön', 'Return to launcher'],
    ['Dokunmatik: Açık', 'Touch: On'], ['Dokunmatik: Kapalı', 'Touch: Off'], ['Dokunmatik ayarları', 'Touch settings'], ['Tanılamayı kaydet', 'Save diagnostics'],
    ['Benzersiz RP', 'Unique RP'], ['Gerçekçi macera', 'Realistic adventure'], ["FiveWeb'e katıl", 'Join FiveWeb'], ['Takip Et', 'Follow'],
    ['Önceki şarkı', 'Previous song'], ['Sonraki şarkı', 'Next song'], ['Müziği çal', 'Play music'], ['Müziği duraklat', 'Pause music'],
    ['Şarkı konumu', 'Song position'], ['Ses düzeyi', 'Volume'], ['{name} bağlantısını kopyala', 'Copy {name} link'], ['{name} kopyalandı!', '{name} copied!'],
    ['Oyun tuşlarını Launcher > Ayarlar > Klavye bölümünden değiştirebilirsiniz; bu liste değişiklikleri gösterir.', 'Change game keys in Launcher > Settings > Keyboard; this list shows your changes.'],
  ];
  const tr = new Map(), en = new Map();
  for (const [a, b] of pairs) { tr.set(a, a); tr.set(b, a); en.set(a, b); en.set(b, b); }
  const nav = root.navigator || {};
  const preferred = nav.languages && nav.languages.length ? nav.languages[0] : nav.language;
  const detected = /^tr/i.test(preferred || '') ? 'tr' : 'en';
  let language = detected;
  try { const saved = root.localStorage.getItem('fiveweb.language'); if (saved === 'tr' || saved === 'en') language = saved; } catch (_) { /* storage may be unavailable */ }
  function t(key, params, fallback) {
    if (typeof params === 'string') { fallback = params; params = null; }
    const value = (language === 'tr' ? tr : en).get(key) || fallback || key;
    return value.replace(/\{(\w+)\}/g, (match, name) => params && Object.hasOwn(params, name) ? String(params[name]) : match);
  }
  const doc = root.document;
  const bindings = [];
  const listeners = new Set();
  let selector;
  function apply() {
    if (!doc) return;
    doc.documentElement.lang = language;
    for (const { node, key, attr, prefix, suffix } of bindings) {
      if (attr) node.setAttribute(attr, t(key));
      else node.textContent = prefix + t(key) + suffix;
    }
    // Launcher/game titles are ours; engine assets and operator text are untouched.
    if (root.location.pathname === '/') doc.title = t('FiveWeb · Sunucular');
    else doc.title = root.location.pathname.startsWith('/game') ? 'FiveWeb · ' + (language === 'tr' ? 'Oyun' : 'Game') : 'FiveWeb · Launcher';
    if (selector) {
      selector.setAttribute('aria-label', t('Dil'));
      selector.options[0].textContent = t('Otomatik (tarayıcı)');
    }
    for (const fn of listeners) fn();
  }
  function setLanguage(value) {
    if (!['tr', 'en', 'auto'].includes(value)) return;
    language = value === 'auto' ? detected : value;
    try { if (value === 'auto') root.localStorage.removeItem('fiveweb.language'); else root.localStorage.setItem('fiveweb.language', value); } catch (_) { /* still usable without storage */ }
    if (selector) selector.value = value;
    apply();
  }
  function init() {
    // Capture only the canonical browser's initial static text, before API/operator rows exist.
    if (root.location.pathname === '/') {
      const walker = doc.createTreeWalker(doc.documentElement, 4);
      let node;
      while ((node = walker.nextNode())) {
        if (['SCRIPT', 'STYLE'].includes(node.parentElement?.tagName)) continue;
        const key = node.textContent.trim();
        if (!en.has(key)) continue;
        const match = node.textContent.match(/^(\s*)[\s\S]*?(\s*)$/);
        bindings.push({ node, key, prefix: match[1], suffix: match[2] });
      }
      for (const node of doc.querySelectorAll('[aria-label], [placeholder], meta[name="description"]')) {
        for (const attr of ['aria-label', 'placeholder', 'content']) {
          const key = node.getAttribute(attr);
          if (key && en.has(key)) bindings.push({ node, key, attr });
        }
      }
    }
    selector = doc.createElement('select');
    selector.id = 'fiveweb-language';
    selector.style.cssText = 'font:inherit;color:inherit;background:#23252d;border:1px solid #676974;border-radius:6px;padding:6px;max-width:190px';
    for (const [value, label] of [['auto', t('Otomatik (tarayıcı)')], ['tr', 'TR · Türkçe'], ['en', 'EN · English']]) {
      const option = doc.createElement('option'); option.value = value; option.textContent = label; selector.append(option);
    }
    try { selector.value = root.localStorage.getItem('fiveweb.language') || 'auto'; } catch (_) { selector.value = 'auto'; }
    selector.addEventListener('change', () => setLanguage(selector.value));
    const host = doc.querySelector('.topbar');
    if (host) host.append(selector);
    else {
      const box = doc.createElement('div');
      box.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:60;color:#fff;font:13px system-ui';
      // Game pages style bare <select>s white: keep the dark pill look of the game toolbar.
      selector.style.cssText = 'font:inherit;color:#f3efe8 !important;background:rgba(18,19,24,.78) !important;border:1px solid rgba(255,255,255,.28) !important;border-radius:999px;padding:6px 12px;max-width:190px;backdrop-filter:blur(6px);color-scheme:dark;cursor:pointer';
      box.append(selector); doc.body.append(box);
    }
    apply();
  }
  root.FiveWebI18n = { t, setLanguage, get language() { return language; }, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
  if (doc) {
    doc.documentElement.lang = language;
    // Body scripts on the canonical browser run before lobby.js. Head injections wait for body.
    if (doc.body) init(); else doc.addEventListener('DOMContentLoaded', init, { once: true });
  }
})(typeof window !== 'undefined' ? window : globalThis);
