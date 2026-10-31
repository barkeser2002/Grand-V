# Sesli sohbet (WebRTC, 2 oyuncu)

## Kullanım ve rıza
- İki oyuncu arasında WebRTC ses; `/relay` medya taşımaz, yalnızca `offer`, `answer`, `ice` iletir.
- Mikrofon yalnızca **Sese katıl** tıklamasıyla istenir. Sayfa yüklenirken ICE isteği, TURN yoklaması ve mikrofon isteği yapılmaz.
- Katılmamış karşı oyuncu mikrofon açmadan recvonly yanıt verebilir; onun adına kimlik bilgisi istenmez veya public TURN yoklaması yapılmaz.
- **Sesi kapat**, pagehide, oyun stop veya soket kapanması mikrofon parçalarını ve bağlantıyı kapatır. Yoklama ve yeniden başlatma zamanlayıcıları da temizlenir. Yoklama sırasında da kullanıcı sesi kapatabilir.
- **Mikrofonu kapat/aç** parçanın `enabled` değerini değiştirir; izin yeniden istenmez. Push-to-talk yoktur.

## Public birincil / kendi coturn yedek politikası
**Bir `iceServers` dizisinde sıra öncelik sağlamaz.** İki sağlayıcı aynı etkin diziye konmaz.

1. Kimliği doğrulanmış `POST /api/voice/ice` public ve kendi TURN gruplarını ayrı döndürür: `iceServers` birincil, `fallbackIceServers` yedek, `provider:'public'`.
2. Tıklamadan sonra istemci yalnızca public grubu kullanan, `iceTransportPolicy:'relay'` ayarlı ayrı bir RTCPeerConnection ve data channel ile allocation yoklaması yapar. Yoklamaya mikrofon eklenmez; SDP/adayı karşı oyuncuya gönderilmez.
3. En fazla **4000 ms** içinde `typ relay` adayı gelirse gerçek bağlantı yalnızca public TURN grubuyla kurulur. Yoklama hatası, adaylar bittiği halde relay bulunmaması veya süre aşımı varsa yalnızca kendi coturn grubu seçilir. Yoklama PC'si, olay işleyicileri ve zamanlayıcısı temizlenir.
4. Allocation başarısı uçtan uca ses garantisi değildir. Public seçilmiş gerçek bağlantının `connectionState` veya `iceConnectionState` değeri `failed` olursa etkin yapılandırma **yalnızca yedek grupla değiştirilir**, aynı PC üzerinde `restartIce()` çağrılır. Mikrofon/parçalar ve uzaktaki ses korunur. Yeniden anlaşma mevcut offer/answer/ice sinyalleri üzerinden yürür; protokole yeni mesaj türü eklenmez.
5. Her katılımda public→yedek geçişi en fazla bir kezdir. Aynı eski ICE neslinin iki hata olayı ikinci deneme sayılmaz. Yedek yeniden deneme 12 saniyede ilerleyemezse veya yeniden başarısız olursa arayüz başarısızlığı söyler; döngüsel yeniden deneme veya sahte “bağlandı” yoktur. Yeniden denemek için çıkıp tekrar katılın.

Arayüz **Genel TURN seçildi (birincil)** / **Yedek TURN seçildi** notlarını ve gerçek `connectionState` durumunu ayrı gösterir. Sağlayıcının seçilmiş olması medyanın kesin TURN üzerinden aktığı iddiası değildir: gerçek ses PC'sinde doğrudan ICE adayları da kullanılabilir. Seçilmiş candidate pair ancak gerçek tarayıcı istatistiklerinden doğrulanır.

## Sunucu yapılandırması (parent/deploy işi)
Kaynak kodda sağlayıcı adresi veya ortak sır sabitlenmez. `.env` repoya eklenmez.

| Ortam değişkeni | İşlev |
| --- | --- |
| `PUBLIC_TURN_URLS` | Public REST-HMAC sağlayıcısının virgülle ayrılmış `turn:` / `turns:` URL'leri |
| `PUBLIC_TURN_SECRET` | Public sağlayıcının REST-HMAC ortak sırrı; yalnızca sunucu ortamında |
| `TURN_URLS` | Kendi coturn URL'leri; public yapılandırılmışsa yalnızca yedek |
| `TURN_SECRET` | Kendi coturn `static-auth-secret` değeri; yalnızca sunucu ortamında |

- Her grup için username=`<bitiş unix saniyesi>:<rastgele>`, credential=`base64(HMAC-SHA1(grubun sırrı, username))`; TTL **600 saniye**. `expiresAt` döner. Ortak sır yanıt veya günlüğe girmez.
- Geçerli public URL+secret yoksa önceki kendi-TURN-only davranışı korunur; kendi grup da yoksa `{iceServers:[], mode:'direct'}` ve NAT uyarısı gösterilir. Public tek başına da yapılandırılabilir; bu durumda olmayan yedek uydurulmaz.
- URL'ler doğrulanır; hatalı girdiler elenir. Üçüncü taraf STUN varsayılanı yoktur.
- Endpoint istek başına ortamı okur. Origin izinli olmalı; gövde yalnızca `{room, credential}`, JSON, en fazla 4 KiB. Canlı veya bekleyen lobi koltuğu doğrulanır; aksi halde ayrıntısız 403. Varsayılan istemci sınırı 20/dk, yanıt `no-store`.
- Kimlik bilgisi yenileme bu sürümde yoktur; uzun oturumun yeni allocation ihtiyacı TTL sonrasında başarısız olabilir. Çıkıp tekrar katılmak yeni kimlik bilgisi alır.

### Public sağlayıcı hakkında doğrulama sınırı
Parent'ın [resmî Open Relay belgesi](https://www.metered.ca/tools/openrelay/) incelemesi REST-HMAC için `staticauth.openrelay.metered.ca:80` adresini doğruladı; yayınlanmış ortak sır deploy ortamında ayarlanmalıdır, bu belgede/kodda tutulmaz. Eski `openrelay.metered.ca` adresini kullanmayın.

Parent'ın bu değişiklik öncesi gerçek UDP ve TCP allocation denemeleri public staticauth:80 için **iki protokolde de 12 saniyede zaman aşımına uğradı**. Public servis çalışıyor/başarıyla ses taşıyor denmiyor. Kendi coturn için daha önce gerçek UDP/TCP allocation ve iki tarayıcıda çift yönlü ses tonu doğrulaması vardı; bu, yeni public→yedek politikasının canlı doğrulaması değildir. Public ücretsiz servis için erişilebilirlik/SLA garantisi verilmez.

## Sinyalleşme ve çakışma
- Aynı lobide tek karşı eş, hedef/gönderen doğrulaması. Sunucu `from` ekler; istemciden sahte `from` reddedilir.
- İki taraf aynı anda offer/restart yaptığında küçük kimlik impolite, büyük kimlik polite (rollback) kalır. `restartIce()` rollback sonrasında da yeniden başlatma isteğini korur.
- Public yoklaması sırasında gelen teklif ve en fazla 64 aday bekletilir; varsayılan/doğrudan bağlantı erken yaratılmaz. Eski katılımın geç sonuçları yeni katılımı diriltmez.
- SDP en fazla 16 KiB, ICE adayı 1 KiB, sinyal çerçevesi 32 KiB; poz çerçevesi hâlâ 2048 bayt. Sinyalin ayrı 20/sn, 40 patlama kovası vardır; SDP günlüğe yazılmaz.

## Test ve deploy kabulü
- `npm test`: tüm web-host paketi. Test sayısı terminal raporunda verilir; burada eski bir toplam tutulmaz.
- `test/voice-ice.test.js`: gerçek HTTP yetkilendirme/Origin/sınır testleri ve fixture sırlarla saf HMAC/grup ayrımı.
- `test/voice-client.test.js`: **sahte** WebRTC, mikrofon ve DOM. Public seçimi, 4 sn yoklama deadline'ı/hataları, yalnız-yedek seçimi, gerçek bağlantı hata olayından ICE restart, 12 sn restart deadline'ı, çift hata mesajı, iki eşte restart/glare, erken aday kuyruğu, rıza ve geç callback temizliği. Bu testler gerçek TURN erişilebilirliği veya gerçek ses kanıtı değildir.
- `test/voice-relay.test.js`: gerçek soketlerde sinyal doğrulama/iletme, izolasyon ve bütçeler. `test/multiplayer-voice.test.js`: sahte WebRTC ile oyun/soket/voice yaşam döngüsü.
- Parent deploy sonrasında iki gerçek tarayıcı/ağ ile public başarılı yolunu ve public erişilemezken yedek yolunu ayrı doğrulamalı; aktif candidate pair, iki yönlü ses, mikrofon kapatma ve iki taraf eşzamanlı yeniden başlatma kontrol edilmeli. Bu görev servis restart, Apache/DNS veya sır yapılandırmasını değiştirmez.
