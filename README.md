# Nuvio Katalog — GitHub tarafı

izlemeli.com yalnızca ayarları (`config.json`) tutar. Katalogların üretimi ve yayını burada yapılır.

```
izlemeli.com panel ──(Kaydet / Buton)──► GitHub Actions ──► TMDB
        ▲                                     │
        └────── config.json (sadece ayar) ────┘
                                              ▼
                                       GitHub Pages (statik JSON)  ◄── Nuvio
```

## Kurulum (bir kez)

1. **Public** bir depo oluştur (örn. `nuvio-katalog`) ve bu dosyaları yükle (`main` branch).
2. **Settings → Pages → Build and deployment → Source: GitHub Actions** seç.
3. **Settings → Secrets and variables → Actions**
   - *Secrets* → `TMDB_KEY` = TMDB API anahtarın (v3 ya da v4 token)
   - *Variables* → `CONFIG_URL` = `https://izlemeli.com/nuvio/config.json`
4. **Actions → "Katalog üret ve yayınla" → Run workflow** ile ilk yayını yap.
5. Adres: `https://KULLANICI.github.io/DEPO/tr/manifest.json` (İngilizce için `/en/`).
   Kök `/manifest.json` varsayılan dili kullanır.

## izlemeli.com panelinden tetiklemek için token

GitHub → Settings → Developer settings → **Fine-grained tokens** → *Generate*
- Repository access: sadece bu depo
- Permissions: **Actions: Read and write** (Metadata: Read otomatik gelir)

Token'ı WordPress'te *Nuvio Katalog → GitHub bağlantısı* alanına yapıştır.

## Notlar
- Hata olursa (TMDB düşerse vb.) yayın **iptal edilir**, önceki çalışan sürüm yayında kalır.
- Her gün 03:17 UTC'de otomatik yenilenir (`build.yml` içindeki cron).
- Sayfa sayısı panelden ayarlanır (varsayılan 5 → kategori başına ~100–200 içerik).
