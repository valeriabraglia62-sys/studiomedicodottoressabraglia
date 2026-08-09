#!/bin/bash

# Script di test per il sistema di prenotazioni mediche aggiornato

echo "Iniziando i test del sistema di prenotazioni mediche..."

# Directory di lavoro
WORK_DIR="/home/ubuntu/medical-booking-system"
cd $WORK_DIR

# Crea una directory per i risultati dei test
TEST_RESULTS_DIR="$WORK_DIR/test_results"
mkdir -p $TEST_RESULTS_DIR

# Test 1: Verifica della struttura dei file
echo "Test 1: Verifica della struttura dei file"
echo "----------------------------------------"

# Verifica la presenza dei file principali
FILES_TO_CHECK=(
  "index.html"
  "css/style.css"
  "js/script.js"
  "js/menu.js"
  "js/auth.js"
  "admin/dashboard.html"
  "admin/login.html"
  "admin/js/admin-base.js"
  "admin/js/dashboard.js"
  "admin/js/prenotazioni.js"
  "admin/js/pazienti.js"
  "admin/js/booking-form.js"
  "admin/js/auth.js"
  "backend/api/prenotazioni.php"
  "backend/api/auth.php"
  "backend/utils/EmailSender.php"
  "backend/utils/GoogleCalendarService.php"
  "backend/utils/NotificationManager.php"
)

MISSING_FILES=0
for file in "${FILES_TO_CHECK[@]}"; do
  if [ ! -f "$WORK_DIR/$file" ]; then
    echo "❌ File mancante: $file"
    MISSING_FILES=$((MISSING_FILES+1))
  else
    echo "✅ File presente: $file"
  fi
done

if [ $MISSING_FILES -eq 0 ]; then
  echo "✅ Test 1 superato: Tutti i file sono presenti"
else
  echo "❌ Test 1 fallito: $MISSING_FILES file mancanti"
fi
echo ""

# Test 2: Verifica della configurazione
echo "Test 2: Verifica della configurazione"
echo "------------------------------------"

# Verifica la presenza degli indirizzi degli ambulatori corretti
ARCETO_ADDRESS=$(grep -o "Via Piazza Castello, 10" $WORK_DIR/backend/config/config.php)
CASALGRANDE_ADDRESS=$(grep -o "Via Canale, 29" $WORK_DIR/backend/config/config.php)

if [ -n "$ARCETO_ADDRESS" ]; then
  echo "✅ Indirizzo Arceto corretto: $ARCETO_ADDRESS"
else
  echo "❌ Indirizzo Arceto non trovato o non corretto"
fi

if [ -n "$CASALGRANDE_ADDRESS" ]; then
  echo "✅ Indirizzo Casalgrande corretto: $CASALGRANDE_ADDRESS"
else
  echo "❌ Indirizzo Casalgrande non trovato o non corretto"
fi

# Verifica la presenza dell'email dell'amministratore
ADMIN_EMAIL=$(grep -o "valeriabraglia62@gmail.com" $WORK_DIR/backend/config/config.php)
if [ -n "$ADMIN_EMAIL" ]; then
  echo "✅ Email amministratore corretta: $ADMIN_EMAIL"
else
  echo "❌ Email amministratore non trovata o non corretta"
fi

# Verifica la presenza della password dell'amministratore
ADMIN_PASSWORD=$(grep -o "[RIMOSSA-DALLA-CRONOLOGIA]" $WORK_DIR/backend/config/config.php)
if [ -n "$ADMIN_PASSWORD" ]; then
  echo "✅ Password amministratore corretta"
else
  echo "❌ Password amministratore non trovata o non corretta"
fi
echo ""

# Test 3: Verifica del testo nella homepage
echo "Test 3: Verifica del testo nella homepage"
echo "----------------------------------------"

# Verifica la presenza del testo corretto nella homepage
HOMEPAGE_TEXT=$(grep -o "Prenotarsi solo nell'ambulatorio di residenza" $WORK_DIR/index.html)
if [ -n "$HOMEPAGE_TEXT" ]; then
  echo "✅ Testo homepage corretto: \"$HOMEPAGE_TEXT\""
else
  echo "❌ Testo homepage non trovato o non corretto"
fi
echo ""

# Test 4: Verifica dell'integrazione con Google Calendar
echo "Test 4: Verifica dell'integrazione con Google Calendar"
echo "----------------------------------------------------"

# Verifica la presenza della classe GoogleCalendarService
if [ -f "$WORK_DIR/backend/utils/GoogleCalendarService.php" ]; then
  # Verifica la presenza dei metodi principali
  CREATE_EVENT=$(grep -o "createEvent" $WORK_DIR/backend/utils/GoogleCalendarService.php)
  DELETE_EVENT=$(grep -o "deleteEvent" $WORK_DIR/backend/utils/GoogleCalendarService.php)
  
  if [ -n "$CREATE_EVENT" ] && [ -n "$DELETE_EVENT" ]; then
    echo "✅ Metodi per la gestione degli eventi del calendario trovati"
  else
    echo "❌ Metodi per la gestione degli eventi del calendario non trovati"
  fi
  
  # Verifica l'integrazione con le prenotazioni
  CALENDAR_INTEGRATION=$(grep -o "add_to_calendar" $WORK_DIR/admin/js/booking-form.js)
  if [ -n "$CALENDAR_INTEGRATION" ]; then
    echo "✅ Integrazione con il form di prenotazione trovata"
  else
    echo "❌ Integrazione con il form di prenotazione non trovata"
  fi
else
  echo "❌ File GoogleCalendarService.php non trovato"
fi
echo ""

# Test 5: Verifica dell'autenticazione con Google e Apple ID
echo "Test 5: Verifica dell'autenticazione con Google e Apple ID"
echo "--------------------------------------------------------"

# Verifica la presenza delle funzioni di autenticazione
if [ -f "$WORK_DIR/admin/js/auth.js" ]; then
  GOOGLE_AUTH=$(grep -o "initiateGoogleLogin" $WORK_DIR/admin/js/auth.js)
  APPLE_AUTH=$(grep -o "initiateAppleLogin" $WORK_DIR/admin/js/auth.js)
  
  if [ -n "$GOOGLE_AUTH" ]; then
    echo "✅ Autenticazione Google implementata"
  else
    echo "❌ Autenticazione Google non implementata"
  fi
  
  if [ -n "$APPLE_AUTH" ]; then
    echo "✅ Autenticazione Apple implementata"
  else
    echo "❌ Autenticazione Apple non implementata"
  fi
else
  echo "❌ File auth.js non trovato"
fi
echo ""

# Test 6: Verifica del menu a tendina
echo "Test 6: Verifica del menu a tendina"
echo "---------------------------------"

# Verifica la presenza del menu a tendina
if [ -f "$WORK_DIR/js/menu.js" ]; then
  MENU_TOGGLE=$(grep -o "toggleMenu" $WORK_DIR/js/menu.js)
  
  if [ -n "$MENU_TOGGLE" ]; then
    echo "✅ Funzionalità del menu a tendina implementata"
  else
    echo "❌ Funzionalità del menu a tendina non implementata"
  fi
  
  # Verifica la presenza del CSS per il menu
  MENU_CSS=$(grep -o "dropdown" $WORK_DIR/css/style.css)
  
  if [ -n "$MENU_CSS" ]; then
    echo "✅ Stile CSS per il menu a tendina implementato"
  else
    echo "❌ Stile CSS per il menu a tendina non implementato"
  fi
else
  echo "❌ File menu.js non trovato"
fi
echo ""

# Test 7: Verifica dell'annullamento delle prenotazioni
echo "Test 7: Verifica dell'annullamento delle prenotazioni"
echo "---------------------------------------------------"

# Verifica la presenza della funzionalità di annullamento
CANCEL_FUNCTION=$(grep -o "cancelPrenotazione" $WORK_DIR/admin/js/prenotazioni.js)
if [ -n "$CANCEL_FUNCTION" ]; then
  echo "✅ Funzione di annullamento prenotazioni implementata"
else
  echo "❌ Funzione di annullamento prenotazioni non implementata"
fi

# Verifica la presenza della funzionalità di annullamento lato paziente
PATIENT_CANCEL=$(grep -o "cancel_booking" $WORK_DIR/backend/api/prenotazioni.php)
if [ -n "$PATIENT_CANCEL" ]; then
  echo "✅ API per l'annullamento prenotazioni implementata"
else
  echo "❌ API per l'annullamento prenotazioni non implementata"
fi

# Verifica la presenza della notifica di annullamento
CANCEL_NOTIFICATION=$(grep -o "sendCancellationNotifications" $WORK_DIR/backend/utils/NotificationManager.php)
if [ -n "$CANCEL_NOTIFICATION" ]; then
  echo "✅ Notifiche di annullamento implementate"
else
  echo "❌ Notifiche di annullamento non implementate"
fi
echo ""

# Test 8: Verifica dell'ottimizzazione per dispositivi mobili
echo "Test 8: Verifica dell'ottimizzazione per dispositivi mobili"
echo "---------------------------------------------------------"

# Verifica la presenza di meta viewport
META_VIEWPORT=$(grep -o "viewport" $WORK_DIR/index.html)
if [ -n "$META_VIEWPORT" ]; then
  echo "✅ Meta viewport trovato nella homepage"
else
  echo "❌ Meta viewport non trovato nella homepage"
fi

# Verifica la presenza di media queries
MEDIA_QUERIES=$(grep -o "@media" $WORK_DIR/css/style.css | wc -l)
if [ $MEDIA_QUERIES -gt 0 ]; then
  echo "✅ Media queries trovate ($MEDIA_QUERIES)"
else
  echo "❌ Media queries non trovate"
fi
echo ""

# Riepilogo dei test
echo "Riepilogo dei test"
echo "----------------"
echo "Test 1: Verifica della struttura dei file"
echo "Test 2: Verifica della configurazione"
echo "Test 3: Verifica del testo nella homepage"
echo "Test 4: Verifica dell'integrazione con Google Calendar"
echo "Test 5: Verifica dell'autenticazione con Google e Apple ID"
echo "Test 6: Verifica del menu a tendina"
echo "Test 7: Verifica dell'annullamento delle prenotazioni"
echo "Test 8: Verifica dell'ottimizzazione per dispositivi mobili"
echo ""

echo "Test completati. Risultati salvati in $TEST_RESULTS_DIR/test_results.txt"

# Salva i risultati in un file
exec > >(tee -a "$TEST_RESULTS_DIR/test_results.txt")

echo "Test completati il $(date)"
