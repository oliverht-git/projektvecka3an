# profilvecka

hur man starta servern är att skriva npm i terminalen och för att stänga den så måste man trycka på ctrl+c

## Rapportering och admin

Om ingen nyckel är konfigurerad skapar servern automatiskt en säker adminnyckel vid start och skriver ut den i terminalen. Kopiera raden `Adminnyckel (kopiera denna): ...` från samma terminal där servern körs. Öppna sedan `http://localhost:3006/admin.html` och ange nyckeln.

Du kan också ange en egen `ADMIN_TOKEN` innan servern startas. I PowerShell:

```powershell
$env:ADMIN_TOKEN = node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
npm start
```

Nyckeln sparas bara i webbläsarens aktuella session. Om servern startas med Docker Compose skickas miljövariabeln `ADMIN_TOKEN` vidare från värddatorn. Utan en egen nyckel skrivs den automatiskt skapade nyckeln ut i serverns logg.

Använd HTTPS och en hemlig, lång adminnyckel när webbplatsen görs tillgänglig utanför den egna datorn. Adminvyn visar anmälda profilbilder och rapporterade meddelanden med tillhörande chattlogg. Loggarna är privata och visas endast via admin-API:t.
