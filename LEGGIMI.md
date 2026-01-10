# TrovaFamiglia 📍

App per la localizzazione familiare con gestione Admin e Mappa.

## 🛠 Configurazione Database (Supabase)

Esegui questo comando nell'SQL Editor di Supabase per aggiornare tutte le colonne necessarie:

```sql
ALTER TABLE family_tracker ADD COLUMN IF NOT EXISTS password TEXT;
ALTER TABLE family_tracker ADD COLUMN IF NOT EXISTS speed FLOAT8;
ALTER TABLE family_tracker ADD COLUMN IF NOT EXISTS device_id TEXT;
```

## 🌟 Funzionalità Avanzate Implementate

1. **Stato Offline Istantaneo**: Se chiudi l'app o disattivi il GPS, il tuo segnalino diventa rosso immediatamente per tutti gli altri.
2. **Ban Dispositivo**: Se blocchi un utente dal pannello Admin, quel cellulare/PC non potrà più registrare nuovi account.
3. **Indicatore Nuvola (☁️)**: Quando vedi la nuvoletta accanto a "GPS OK", significa che la tua posizione è stata salvata correttamente sul server.
4. **Recupero Admin Fabio**: L'utente "Fabio" riottiene automaticamente i poteri di amministratore e l'attivazione della trasmissione ad ogni accesso.

## 🚀 Utilizzo

1. **Login/Registrazione**: 
   - Inserisci Nome e Password.
   - Se il nome è nuovo, vieni registrato ed entri subito.
   - Se il nome esiste, devi inserire la password corretta.

2. **Admin (Fabio)**:
   - Se sei l'admin, vedrai un pulsante ingranaggio ⚙️ sulla mappa.
   - Puoi bloccare/sbloccare gli utenti (anche i nuovi registrati).
   - **Test Salvataggio**: Nel pannello admin puoi forzare un test di scrittura nel database.

3. **Mappa**:
   - I nomi vicini vengono raggruppati per non sovrapporsi.
   - Zooma per vedere i dettagli.
