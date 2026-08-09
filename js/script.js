import { initAuth, googleSignIn, getAccessToken } from './firebase-auth.js';

// Variabili globali
let selectedDate = null;
let selectedSlot = null;
let selectedAmbulatorio = null;

// Dati degli ambulatori con orari aggiornati
const ambulatori = {
    "Arceto": {
        "lunedi": { inizio: "10:30", fine: "13:00" },
        "martedi": { inizio: "10:30", fine: "13:00" },
        "mercoledi": { inizio: "17:00", fine: "19:00" },
        "giovedi": { inizio: "10:30", fine: "13:00" },
        "venerdi": { inizio: "10:30", fine: "13:00" }
    },
    "Casalgrande": {
        "lunedi": { inizio: "17:00", fine: "19:00" },
        "martedi": { inizio: null, fine: null }, // Chiuso
        "mercoledi": { inizio: "08:30", fine: "10:00" },
        "giovedi": { inizio: "17:00", fine: "19:00" },
        "venerdi": { inizio: "08:30", fine: "10:00" }
    }
};

// Giorni della settimana in italiano
const giorni = ["domenica", "lunedi", "martedi", "mercoledi", "giovedi", "venerdi", "sabato"];

// Mesi in italiano
const mesi = ["Gennaio", "Febbraio", "Marzo", "Aprile", "Maggio", "Giugno", "Luglio", "Agosto", "Settembre", "Ottobre", "Novembre", "Dicembre"];

// Inizializzazione al caricamento della pagina
document.addEventListener('DOMContentLoaded', function() {
    let isUserSignedIn = false;
    let userAccessToken = null;

    initAuth((user, token) => {
        isUserSignedIn = !!token;
        userAccessToken = token;
        updateConfirmationButton();
    });

    function updateConfirmationButton() {
        const googleBtn = document.getElementById('google-signin-btn');
        const confirmBtn = document.getElementById('conferma-btn');
        if (googleBtn && confirmBtn) {
            if (isUserSignedIn) {
                googleBtn.style.display = 'none';
                confirmBtn.style.display = 'inline-block';
            } else {
                googleBtn.style.display = 'inline-block';
                confirmBtn.style.display = 'none';
            }
        }
    }

    document.getElementById('google-signin-btn')?.addEventListener('click', async () => {
        try {
            await googleSignIn();
            // Button visibility is handled by initAuth callback
        } catch (error) {
            console.error(error);
        }
    });

    // Inizializza il calendario
    initCalendar();
    
    // Event listener per il pulsante di verifica
    document.getElementById('verifica-btn').addEventListener('click', verificaDati);
    
    // Event listener per chiudere il modal
    document.querySelectorAll('.close-modal').forEach(function(element) {
        element.addEventListener('click', function() {
            document.getElementById('confirmation-modal').style.display = 'none';
        });
    });
    
    // Event listener per il pulsante di modifica
    document.getElementById('modifica-btn').addEventListener('click', function() {
        document.getElementById('confirmation-modal').style.display = 'none';
    });
    
    // Event listener per il pulsante di conferma
    document.getElementById('conferma-btn').addEventListener('click', confermaPrenotazione);
    
    // Event listener per chiudere il modal di successo
    document.getElementById('chiudi-success-btn').addEventListener('click', function() {
        document.getElementById('success-modal').style.display = 'none';
        resetForm();
    });

    // Event listener per le mie prenotazioni
    const myAppointmentsBtn = document.getElementById('my-appointments-btn');
    if (myAppointmentsBtn) {
        myAppointmentsBtn.addEventListener('click', function(e) {
            e.preventDefault();
            showMyAppointments();
        });
    }

    const myAppointmentsModal = document.getElementById('my-appointments-modal');
    if (myAppointmentsModal) {
        const closeModalBtn = myAppointmentsModal.querySelector('.close-modal');
        if (closeModalBtn) {
            closeModalBtn.addEventListener('click', function() {
                myAppointmentsModal.style.display = 'none';
            });
        }
    }
});

// Inizializza il calendario
function initCalendar() {
    const today = new Date();
    const currentMonth = today.getMonth();
    const currentYear = today.getFullYear();
    
    generateCalendar(currentMonth, currentYear);
    
    // Aggiungi navigazione mesi
    const datePickerContainer = document.getElementById('date-picker');
    const navigationDiv = document.createElement('div');
    navigationDiv.className = 'calendar-navigation';
    navigationDiv.innerHTML = `
        <button id="prev-month" class="btn btn-secondary">&lt; Mese precedente</button>
        <h3 id="current-month-display">${mesi[currentMonth]} ${currentYear}</h3>
        <button id="next-month" class="btn btn-secondary">Mese successivo &gt;</button>
    `;
    datePickerContainer.prepend(navigationDiv);
    
    // Event listeners per la navigazione
    document.getElementById('prev-month').addEventListener('click', function() {
        let month = parseInt(document.getElementById('calendar-table').dataset.month);
        let year = parseInt(document.getElementById('calendar-table').dataset.year);
        
        month--;
        if (month < 0) {
            month = 11;
            year--;
        }
        
        generateCalendar(month, year);
        document.getElementById('current-month-display').textContent = `${mesi[month]} ${year}`;
    });
    
    document.getElementById('next-month').addEventListener('click', function() {
        let month = parseInt(document.getElementById('calendar-table').dataset.month);
        let year = parseInt(document.getElementById('calendar-table').dataset.year);
        
        month++;
        if (month > 11) {
            month = 0;
            year++;
        }
        
        generateCalendar(month, year);
        document.getElementById('current-month-display').textContent = `${mesi[month]} ${year}`;
    });
}

// Genera il calendario per il mese e anno specificati
function generateCalendar(month, year) {
    const datePickerContainer = document.getElementById('date-picker');
    const calendarTable = document.createElement('table');
    calendarTable.id = 'calendar-table';
    calendarTable.className = 'calendar';
    calendarTable.dataset.month = month;
    calendarTable.dataset.year = year;
    
    // Intestazione con i giorni della settimana
    const headerRow = document.createElement('tr');
    const daysOfWeek = ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'];
    
    daysOfWeek.forEach(day => {
        const th = document.createElement('th');
        th.textContent = day;
        headerRow.appendChild(th);
    });
    
    calendarTable.appendChild(headerRow);
    
    // Ottieni il primo giorno del mese
    const firstDay = new Date(year, month, 1);
    const startingDay = firstDay.getDay();
    
    // Ottieni il numero di giorni nel mese
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    
    // Ottieni la data di oggi
    const today = new Date();
    
    // Crea le celle del calendario
    let date = 1;
    for (let i = 0; i < 6; i++) {
        // Crea una riga per ogni settimana
        const row = document.createElement('tr');
        
        // Crea le celle per ogni giorno della settimana
        for (let j = 0; j < 7; j++) {
            const cell = document.createElement('td');
            
            if (i === 0 && j < startingDay) {
                // Celle vuote prima dell'inizio del mese
                row.appendChild(cell);
            } else if (date > daysInMonth) {
                // Interrompi quando abbiamo raggiunto la fine del mese
                break;
            } else {
                // Aggiungi il numero del giorno
                cell.textContent = date;
                
                // Controlla se il giorno è disponibile per prenotazioni
                const currentDate = new Date(year, month, date);
                const dayOfWeek = giorni[currentDate.getDay()];
                
                // Verifica se è un giorno lavorativo (lunedì-venerdì)
                if (dayOfWeek !== 'sabato' && dayOfWeek !== 'domenica') {
                    // Verifica se ci sono ambulatori aperti in questo giorno
                    let isAvailable = false;
                    
                    for (const ambulatorio in ambulatori) {
                        if (ambulatori[ambulatorio][dayOfWeek] && ambulatori[ambulatorio][dayOfWeek].inizio !== null) {
                            isAvailable = true;
                            break;
                        }
                    }
                    
                    // Verifica se la data è nel futuro
                    const isPastDate = currentDate < new Date(today.setHours(0, 0, 0, 0));
                    
                    if (isAvailable && !isPastDate) {
                        cell.classList.add('available');
                        cell.dataset.date = `${year}-${(month + 1).toString().padStart(2, '0')}-${date.toString().padStart(2, '0')}`;
                        
                        // Aggiungi event listener per la selezione della data
                        cell.addEventListener('click', function() {
                            // Rimuovi la classe selected da tutte le celle
                            document.querySelectorAll('.calendar td.selected').forEach(el => {
                                el.classList.remove('selected');
                            });
                            
                            // Aggiungi la classe selected a questa cella
                            this.classList.add('selected');
                            
                            // Salva la data selezionata
                            selectedDate = this.dataset.date;
                            
                            // Mostra gli slot disponibili per questa data
                            showAvailableSlots(selectedDate);
                        });
                    } else {
                        cell.classList.add('unavailable');
                    }
                } else {
                    cell.classList.add('unavailable');
                }
                
                row.appendChild(cell);
                date++;
            }
        }
        
        calendarTable.appendChild(row);
        
        // Interrompi se abbiamo raggiunto la fine del mese
        if (date > daysInMonth) {
            break;
        }
    }
    
    // Rimuovi il calendario precedente se esiste
    const oldCalendar = document.getElementById('calendar-table');
    if (oldCalendar) {
        oldCalendar.remove();
    }
    
    // Aggiungi il nuovo calendario
    datePickerContainer.appendChild(calendarTable);
}

// Mostra gli slot disponibili per la data selezionata
async function showAvailableSlots(dateString) {
    // Mostra la sezione degli slot
    document.getElementById('time-slots').style.display = 'block';
    
    // Nascondi il form
    document.getElementById('booking-form').style.display = 'none';
    
    // Ottieni il giorno della settimana
    const date = new Date(dateString);
    const dayOfWeek = giorni[date.getDay()];
    
    // Formatta la data per la visualizzazione
    const formattedDate = `${date.getDate()} ${mesi[date.getMonth()]} ${date.getFullYear()}`;
    
    // Crea gli slot per ogni ambulatorio
    const slotsContainer = document.getElementById('slots-container');
    slotsContainer.innerHTML = `<h4>Slot disponibili per ${formattedDate}</h4><p><i class="fas fa-spinner fa-spin"></i> Caricamento slot...</p>`;

    let bookedSlots = [];
    try {
        const res = await fetch(`/backend/api/prenotazioni.php?action=get_all&data=${dateString}`);
        const data = await res.json();
        if (data.success && data.prenotazioni) {
            bookedSlots = data.prenotazioni.filter(p => p.stato === 'confermata' || p.stato === 'completata');
        }
    } catch(err) {
        console.error('Errore durante il recupero delle prenotazioni:', err);
    }
    
    slotsContainer.innerHTML = `<h4>Slot disponibili per ${formattedDate}</h4>`;
    
    // Controlla quali ambulatori sono aperti in questo giorno
    for (const ambulatorio in ambulatori) {
        if (ambulatori[ambulatorio][dayOfWeek] && ambulatori[ambulatorio][dayOfWeek].inizio !== null) {
            const orari = ambulatori[ambulatorio][dayOfWeek];
            
            // Crea un div per questo ambulatorio
            const ambulatorioDiv = document.createElement('div');
            ambulatorioDiv.className = 'ambulatorio-slots';
            ambulatorioDiv.innerHTML = `<h5>Ambulatorio di ${ambulatorio}</h5>`;
            
            // Genera gli slot di 30 minuti
            const slots = generateTimeSlots(orari.inizio, orari.fine);
            
            // Crea i pulsanti per gli slot
            const slotsDiv = document.createElement('div');
            slotsDiv.className = 'slots-buttons';
            
            slots.forEach(slot => {
                const button = document.createElement('button');
                button.className = 'btn slot-btn';
                button.textContent = slot;
                button.dataset.time = slot;
                button.dataset.ambulatorio = ambulatorio;

                // Controlla se lo slot è prenotato
                const isBooked = bookedSlots.some(p => 
                    p.ambulatorio_nome.includes(ambulatorio) && 
                    p.ora_inizio === `${slot}:00`
                );

                if (isBooked) {
                    button.classList.add('booked');
                    button.disabled = true;
                    button.textContent = `${slot} (Non disp.)`;
                    button.style.backgroundColor = '#ccc';
                    button.style.cursor = 'not-allowed';
                    button.style.color = '#666';
                } else {
                    // Aggiungi event listener per la selezione dello slot solo se non prenotato
                    button.addEventListener('click', function() {
                        // Rimuovi la classe selected da tutti i pulsanti
                        document.querySelectorAll('.slot-btn.selected').forEach(el => {
                            el.classList.remove('selected');
                        });
                        
                        // Aggiungi la classe selected a questo pulsante
                        this.classList.add('selected');
                        
                        // Salva lo slot e l'ambulatorio selezionati
                        selectedSlot = this.dataset.time;
                        selectedAmbulatorio = this.dataset.ambulatorio;
                        
                        // Mostra il form di prenotazione
                        showBookingForm(formattedDate, selectedSlot, selectedAmbulatorio);
                    });
                }
                
                slotsDiv.appendChild(button);
            });
            
            ambulatorioDiv.appendChild(slotsDiv);
            slotsContainer.appendChild(ambulatorioDiv);
        }
    }
}

// Genera gli slot di tempo di 30 minuti tra inizio e fine
function generateTimeSlots(inizio, fine) {
    const slots = [];
    
    // Converti le stringhe in oggetti Date
    let startTime = new Date();
    let [startHours, startMinutes] = inizio.split(':').map(Number);
    startTime.setHours(startHours, startMinutes, 0);
    
    let endTime = new Date();
    let [endHours, endMinutes] = fine.split(':').map(Number);
    endTime.setHours(endHours, endMinutes, 0);
    
    // Genera gli slot di 30 minuti
    let currentTime = new Date(startTime);
    
    while (currentTime < endTime) {
        // Formatta l'ora corrente
        const hours = currentTime.getHours().toString().padStart(2, '0');
        const minutes = currentTime.getMinutes().toString().padStart(2, '0');
        slots.push(`${hours}:${minutes}`);
        
        // Aggiungi 30 minuti
        currentTime.setMinutes(currentTime.getMinutes() + 30);
    }
    
    return slots;
}

// Mostra il form di prenotazione
function showBookingForm(date, time, ambulatorio) {
    // Mostra il form
    document.getElementById('booking-form').style.display = 'block';
    
    // Aggiorna le informazioni visualizzate
    document.getElementById('ambulatorio-display').textContent = ambulatorio;
    document.getElementById('datetime-display').textContent = `${date} alle ${time}`;
}

// Verifica i dati inseriti
function verificaDati() {
    // Ottieni i valori dal form
    const nome = document.getElementById('nome').value.trim();
    const cognome = document.getElementById('cognome').value.trim();
    const email = document.getElementById('email').value.trim();
    const telefono = document.getElementById('telefono').value.trim();
    const problema = document.getElementById('problema').value.trim();
    
    // Verifica che i campi obbligatori siano compilati
    if (!nome || !cognome || !telefono || !problema) {
        showAlert('Compila tutti i campi obbligatori.', 'error');
        return;
    }
    
    // Verifica che l'email sia valida se inserita
    if (email && !isValidEmail(email)) {
        showAlert('Inserisci un indirizzo email valido.', 'error');
        return;
    }
    
    // Verifica che il telefono sia valido
    if (!isValidPhone(telefono)) {
        showAlert('Inserisci un numero di telefono valido.', 'error');
        return;
    }
    
    // Aggiorna i dati nel modal di conferma
    document.getElementById('confirm-nome').textContent = nome;
    document.getElementById('confirm-cognome').textContent = cognome;
    document.getElementById('confirm-email').textContent = email || 'Non specificata';
    document.getElementById('confirm-telefono').textContent = telefono;
    document.getElementById('confirm-problema').textContent = problema;
    document.getElementById('confirm-ambulatorio').textContent = selectedAmbulatorio;
    document.getElementById('confirm-datetime').textContent = document.getElementById('datetime-display').textContent;
    
    // Mostra il modal di conferma
    document.getElementById('confirmation-modal').style.display = 'block';
}

// Conferma la prenotazione
function confermaPrenotazione() {
    // Nascondi il modal di conferma
    document.getElementById('confirmation-modal').style.display = 'none';
    
    // Aggiorna i dati nel modal di successo
    document.getElementById('success-ambulatorio').textContent = selectedAmbulatorio;
    
    const datetimeParts = document.getElementById('datetime-display').textContent.split(' alle ');
    
    const payload = {
      nome: document.getElementById('confirm-nome').textContent,
      cognome: document.getElementById('confirm-cognome').textContent,
      email: document.getElementById('confirm-email').textContent === 'Non specificata' ? '' : document.getElementById('confirm-email').textContent,
      telefono: document.getElementById('confirm-telefono').textContent,
      problema: document.getElementById('confirm-problema').textContent,
      date: selectedDate, // Use the global ISO YYYY-MM-DD
      ora: datetimeParts[1],
      ambulatorio: selectedAmbulatorio,
      slot_id: 101, // Dummy ID or derive from selectedAmbulatorio
      googleToken: getAccessToken()
    };

    fetch('/backend/api/prenotazioni.php?action=create_booking', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    .then(res => res.json())
    .then(data => {
      document.getElementById('success-data').textContent = datetimeParts[0];
      document.getElementById('success-ora').textContent = datetimeParts[1];
      
      // Salva la prenotazione in localStorage per "Le mie prenotazioni"
      const newAppointment = {
          id: data.prenotazione_id || Date.now().toString(),
          nome: payload.nome,
          cognome: payload.cognome,
          email: payload.email,
          telefono: payload.telefono,
          problema: payload.problema,
          ambulatorio: selectedAmbulatorio,
          data: datetimeParts[0],
          isoDate: selectedDate, // Store ISO date separately for cancel check
          ora: datetimeParts[1]
      };
      let appointments = JSON.parse(localStorage.getItem('myAppointments') || '[]');
      appointments.push(newAppointment);
      localStorage.setItem('myAppointments', JSON.stringify(appointments));
      
      // Mostra il modal di successo
      document.getElementById('success-modal').style.display = 'block';
    })
    .catch(err => {
      console.error('Errore durante la prenotazione:', err);
      showAlert('Si è verificato un errore durante la prenotazione. Riprova più tardi.', 'error');
    });
}

// Resetta il form e torna al calendario
function resetForm() {
    // Resetta il form
    document.getElementById('booking-form').reset();
    
    // Nascondi il form e gli slot
    document.getElementById('booking-form').style.display = 'none';
    document.getElementById('time-slots').style.display = 'none';
    
    // Deseleziona la data
    document.querySelectorAll('.calendar td.selected').forEach(el => {
        el.classList.remove('selected');
    });
    
    // Resetta le variabili globali
    selectedDate = null;
    selectedSlot = null;
    selectedAmbulatorio = null;
}

// Funzione per mostrare messaggi di alert
function showAlert(message, type) {
    const alertContainer = document.getElementById('alert-container');
    
    // Crea l'elemento alert
    const alertDiv = document.createElement('div');
    alertDiv.className = `alert alert-${type}`;
    alertDiv.textContent = message;
    
    // Aggiungi un pulsante di chiusura
    const closeButton = document.createElement('button');
    closeButton.className = 'close-alert';
    closeButton.innerHTML = '&times;';
    closeButton.addEventListener('click', function() {
        alertDiv.remove();
    });
    
    alertDiv.appendChild(closeButton);
    
    // Aggiungi l'alert al container
    alertContainer.appendChild(alertDiv);
    
    // Rimuovi l'alert dopo 5 secondi
    setTimeout(() => {
        alertDiv.remove();
    }, 5000);
}

// Funzione per mostrare messaggi di alert in un container specifico
function showAlertInContainer(message, type, containerId) {
    const alertContainer = document.getElementById(containerId);
    
    if (!alertContainer) {
        console.error(`Container ${containerId} non trovato`);
        return;
    }
    
    // Rimuovi eventuali alert precedenti
    alertContainer.innerHTML = '';
    
    // Crea l'elemento alert
    const alertDiv = document.createElement('div');
    alertDiv.className = `alert alert-${type}`;
    alertDiv.textContent = message;
    
    // Aggiungi l'alert al container
    alertContainer.appendChild(alertDiv);
    
    // Rimuovi l'alert dopo 5 secondi
    setTimeout(() => {
        alertDiv.remove();
    }, 5000);
}

// Funzione per validare l'email
function isValidEmail(email) {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(email);
}

// Funzione per validare il numero di telefono
function isValidPhone(phone) {
    // Accetta numeri di telefono italiani con o senza prefisso internazionale
    const re = /^(\+39)?[0-9]{9,10}$/;
    return re.test(phone.replace(/\s/g, ''));
}

// Funzioni per Le Mie Prenotazioni
function showMyAppointments() {
    const modal = document.getElementById('my-appointments-modal');
    if (!modal) return;
    
    const appointmentsList = document.getElementById('appointments-list');
    const loading = document.getElementById('appointments-loading');
    
    modal.style.display = 'block';
    
    if (loading) loading.style.display = 'none';
    if (!appointmentsList) return;
    
    const appointments = JSON.parse(localStorage.getItem('myAppointments') || '[]');
    
    if (appointments.length === 0) {
        appointmentsList.innerHTML = '<p class="text-center" style="padding: 20px;">Non hai ancora effettuato nessuna prenotazione.</p>';
        return;
    }
    
    let html = '<div style="display: flex; flex-direction: column; gap: 15px;">';
    appointments.forEach(app => {
        html += `
            <div style="border: 1px solid #ddd; border-radius: 8px; padding: 15px; background-color: #f9f9f9;">
                <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 10px;">
                    <h4 style="margin: 0; color: #2c3e50; font-size: 1.1rem;">Visita - ${app.ambulatorio}</h4>
                    <button class="btn btn-danger btn-sm" onclick="cancelAppointment('${app.id}')" style="background-color: #e74c3c; color: white; border: none; padding: 5px 10px; border-radius: 4px; cursor: pointer; display: flex; align-items: center; gap: 5px;">
                        <i class="fas fa-times"></i> Annulla
                    </button>
                </div>
                <div style="display: flex; gap: 20px; font-size: 0.95rem; margin-bottom: 8px;">
                    <div><i class="far fa-calendar-alt"></i> <strong>${app.data}</strong></div>
                    <div><i class="far fa-clock"></i> <strong>${app.ora}</strong></div>
                </div>
                <div style="font-size: 0.9rem; color: #555;">
                    <div><strong>Paziente:</strong> ${app.nome} ${app.cognome}</div>
                    <div><strong>Motivo:</strong> ${app.problema}</div>
                </div>
            </div>
        `;
    });
    html += '</div>';
    
    appointmentsList.innerHTML = html;
}

window.cancelAppointment = function(id) {
    let appointments = JSON.parse(localStorage.getItem('myAppointments') || '[]');
    const app = appointments.find(a => a.id === id);
    if (!app) return;

    // Controllo 30 minuti prima
    let isoDateStr = app.isoDate;
    if (!isoDateStr) {
        // Fallback for older localStorage items
        const dataParts = app.data.split('/');
        isoDateStr = dataParts.length === 3 ? `${dataParts[2]}-${dataParts[1]}-${dataParts[0]}` : app.data;
    }
    const appTime = new Date(`${isoDateStr}T${app.ora}:00`);
    const now = new Date();
    const diffMs = appTime - now;
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 30) {
        showAlert('Non puoi annullare una prenotazione a meno di 30 minuti dall\'evento.', 'error');
        return;
    }

    if (confirm('Sei sicuro di voler annullare questa prenotazione?')) {
        fetch('/backend/api/prenotazioni.php?action=cancel_booking', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: app.id, patient_email: app.email, googleToken: getAccessToken() })
        })
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                appointments = appointments.filter(a => a.id !== id);
                localStorage.setItem('myAppointments', JSON.stringify(appointments));
                showMyAppointments();
                showAlert('Prenotazione annullata con successo.', 'success');
            } else {
                showAlert(data.message || 'Errore durante l\'annullamento.', 'error');
            }
        })
        .catch(err => {
            console.error(err);
            showAlert('Errore di connessione. Riprova più tardi.', 'error');
        });
    }
};
