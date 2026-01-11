-- Esegui questo script nell'SQL Editor di Supabase

-- 1. Aggiungi colonna per approvazione utenti (Default: FALSE così i nuovi sono bloccati)
ALTER TABLE family_tracker ADD COLUMN IF NOT EXISTS approved BOOLEAN DEFAULT FALSE;

-- 2. Aggiungi colonna per i gruppi (Array di testo, es: ["famiglia", "lavoro"])
ALTER TABLE family_tracker ADD COLUMN IF NOT EXISTS allowed_groups TEXT[];

-- 3. Assicura che l'Admin Fabio sia approvato e Admin
UPDATE family_tracker 
SET approved = TRUE, is_admin = TRUE, allowed_groups = ARRAY['famiglia', 'lavoro', 'amici'] 
WHERE name ILIKE 'Fabio';

-- 4. (Opzionale) Approva tutti gli utenti esistenti per non bloccarli subito
-- Rimuovi il commento se vuoi che tutti gli attuali utenti restino attivi
-- UPDATE family_tracker SET approved = TRUE WHERE approved IS NULL;
