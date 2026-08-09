import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
import fs from 'fs';
import { google } from 'googleapis';

// Try to load .env.example if it exists, since the user put secrets there
if (fs.existsSync('.env.example')) {
  dotenv.config({ path: '.env.example', override: true });
} else {
  dotenv.config({ override: true });
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configuration
const CONFIG = {
  admin_email: process.env.ADMIN_EMAIL || 'admin@example.com',
  admin_password: process.env.ADMIN_PASSWORD || 'admin123'
};

const hasRealEmailConfig = process.env.EMAIL_USER && process.env.EMAIL_PASS && process.env.EMAIL_USER !== 'your-email@gmail.com';

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER || 'your-email@gmail.com',
    pass: process.env.EMAIL_PASS || 'your-app-password'
  }
});

async function createGoogleCalendarEvent(booking, accessToken) {
  if (!accessToken) return null;
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  const calendar = google.calendar({ version: 'v3', auth });
  
  const startTime = new Date(`${booking.data_slot}T${booking.ora_inizio}`);
  const endTime = new Date(startTime.getTime() + 30 * 60000);
  
  const event = {
    summary: `Visita Medica - ${booking.paziente_nome} ${booking.paziente_cognome}`,
    description: `Ambulatorio: ${booking.ambulatorio_nome}\nMotivo: ${booking.problema}`,
    location: booking.ambulatorio_indirizzo,
    start: {
      dateTime: startTime.toISOString(),
      timeZone: 'Europe/Rome',
    },
    end: {
      dateTime: endTime.toISOString(),
      timeZone: 'Europe/Rome',
    },
    attendees: [
      { email: 'valeriabraglia62@gmail.com' },
      ...(booking.paziente_email ? [{ email: booking.paziente_email }] : [])
    ],
  };

  try {
    const res = await calendar.events.insert({
      calendarId: 'primary',
      resource: event,
      sendUpdates: 'all',
    });
    return res.data.id;
  } catch (error) {
    console.error('Error creating Google Calendar event:', error);
    return null;
  }
}

async function deleteGoogleCalendarEvent(eventId, accessToken) {
  if (!accessToken || !eventId) return;
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  const calendar = google.calendar({ version: 'v3', auth });
  try {
    await calendar.events.delete({
      calendarId: 'primary',
      eventId: eventId,
      sendUpdates: 'all',
    });
  } catch (error) {
    console.error('Error deleting Google Calendar event:', error);
  }
}


// In-Memory Database Stores
const ambulatori = [
  {
    id: 1,
    nome: 'Ambulatorio di Arceto',
    indirizzo: 'Via Piazza Castello, 10 - Arceto',
    telefono: '0522980035',
    orari: {
      lunedi: { inizio: '10:30', fine: '13:00' },
      martedi: { inizio: '10:30', fine: '13:00' },
      mercoledi: { inizio: '17:00', fine: '19:00' },
      giovedi: { inizio: '10:30', fine: '13:00' },
      venerdi: { inizio: '10:30', fine: '13:00' },
      sabato: { inizio: null, fine: null },
      domenica: { inizio: null, fine: null }
    }
  },
  {
    id: 2,
    nome: 'Ambulatorio di Casalgrande',
    indirizzo: 'Via Canale, 29 - Casalgrande',
    telefono: '3472450118',
    orari: {
      lunedi: { inizio: '17:00', fine: '19:00' },
      martedi: { inizio: null, fine: null },
      mercoledi: { inizio: '08:30', fine: '10:00' },
      giovedi: { inizio: '17:00', fine: '19:00' },
      venerdi: { inizio: '08:30', fine: '10:00' },
      sabato: { inizio: null, fine: null },
      domenica: { inizio: null, fine: null }
    }
  }
];

let pazienti = [
  { id: 1, nome: 'Mario', cognome: 'Rossi', email: 'mario.rossi@example.com', telefono: '3331234567', num_prenotazioni: 2 },
  { id: 2, nome: 'Laura', cognome: 'Bianchi', email: 'laura.bianchi@example.com', telefono: '3349876543', num_prenotazioni: 1 },
  { id: 3, nome: 'Giuseppe', cognome: 'Verdi', email: 'giuseppe.verdi@example.com', telefono: '3355551234', num_prenotazioni: 1 },
  { id: 4, nome: 'Elena', cognome: 'Neri', email: 'elena.neri@example.com', telefono: '3381122334', num_prenotazioni: 1 }
];

const todayStr = new Date().toISOString().split('T')[0];

let prenotazioni = [
  {
    id: 1,
    slot_id: 101,
    data_slot: todayStr,
    ora_inizio: '11:00:00',
    ora_fine: '11:15:00',
    ambulatorio_id: 1,
    ambulatorio_nome: 'Ambulatorio di Arceto',
    ambulatorio_indirizzo: 'Via Piazza Castello, 10 - Arceto',
    paziente_id: 1,
    paziente_nome: 'Mario',
    paziente_cognome: 'Rossi',
    paziente_telefono: '3331234567',
    paziente_email: 'mario.rossi@example.com',
    problema: 'Visita di controllo generale e prescrizione ricette',
    stato: 'confermata',
    evento_calendar_id: 'evt_001',
    cancellato_da: null,
    data_cancellazione: null
  },
  {
    id: 2,
    slot_id: 102,
    data_slot: todayStr,
    ora_inizio: '11:15:00',
    ora_fine: '11:30:00',
    ambulatorio_id: 1,
    ambulatorio_nome: 'Ambulatorio di Arceto',
    ambulatorio_indirizzo: 'Via Piazza Castello, 10 - Arceto',
    paziente_id: 2,
    paziente_nome: 'Laura',
    paziente_cognome: 'Bianchi',
    paziente_telefono: '3349876543',
    paziente_email: 'laura.bianchi@example.com',
    problema: 'Controllo pressione e rinnovo certificato',
    stato: 'confermata',
    evento_calendar_id: 'evt_002',
    cancellato_da: null,
    data_cancellazione: null
  },
  {
    id: 3,
    slot_id: 201,
    data_slot: todayStr,
    ora_inizio: '17:30:00',
    ora_fine: '17:45:00',
    ambulatorio_id: 2,
    ambulatorio_nome: 'Ambulatorio di Casalgrande',
    ambulatorio_indirizzo: 'Via Canale, 29 - Casalgrande',
    paziente_id: 3,
    paziente_nome: 'Giuseppe',
    paziente_cognome: 'Verdi',
    paziente_telefono: '3355551234',
    paziente_email: 'giuseppe.verdi@example.com',
    problema: 'Sintomi influenzali e febbre lieve',
    stato: 'confermata',
    evento_calendar_id: null,
    cancellato_da: null,
    data_cancellazione: null
  }
];

let nextBookingId = 4;
let nextPatientId = 5;

// Helper function to generate time slots for a given date
function getSlotsForDate(dateStr, ambulatorioId = null) {
  const dateObj = new Date(dateStr + 'T00:00:00');
  const dayIndex = dateObj.getDay(); // 0=Sunday, 1=Monday, ...
  const dayNames = ['domenica', 'lunedi', 'martedi', 'mercoledi', 'giovedi', 'venerdi', 'sabato'];
  const dayName = dayNames[dayIndex];

  const slots = [];
  let slotCounter = 1;

  const filteredAmbulatori = ambulatorioId 
    ? ambulatori.filter(a => a.id == ambulatorioId)
    : ambulatori;

  filteredAmbulatori.forEach(amb => {
    const daySchedule = amb.orari[dayName];
    if (!daySchedule || !daySchedule.inizio || !daySchedule.fine) {
      return;
    }

    const [startH, startM] = daySchedule.inizio.split(':').map(Number);
    const [endH, endM] = daySchedule.fine.split(':').map(Number);

    let startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    while (startMinutes + 15 <= endMinutes) {
      const h1 = String(Math.floor(startMinutes / 60)).padStart(2, '0');
      const m1 = String(startMinutes % 60).padStart(2, '0');
      const nextMin = startMinutes + 15;
      const h2 = String(Math.floor(nextMin / 60)).padStart(2, '0');
      const m2 = String(nextMin % 60).padStart(2, '0');

      const ora_inizio = `${h1}:${m1}:00`;
      const ora_fine = `${h2}:${m2}:00`;
      const slot_id = amb.id * 1000 + slotCounter++;

      // Check availability against active bookings
      const isBooked = prenotazioni.some(p => 
        p.data_slot === dateStr && 
        p.ambulatorio_id === amb.id && 
        p.ora_inizio === ora_inizio && 
        p.stato === 'confermata'
      );

      slots.push({
        id: slot_id,
        data: dateStr,
        ora_inizio,
        ora_fine,
        disponibile: !isBooked,
        ambulatorio_id: amb.id,
        ambulatorio_nome: amb.nome
      });

      startMinutes += 15;
    }
  });

  return slots;
}

// CORS Headers Middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// API Endpoint 1: Ambulatori
app.all('/backend/api/ambulatori.php', (req, res) => {
  const action = req.query.action || '';

  if (action === 'get_ambulatori') {
    return res.json({ success: true, ambulatori });
  }

  if (action === 'get_orari') {
    const ambId = req.query.ambulatorio_id;
    const amb = ambulatori.find(a => a.id == ambId);
    if (!amb) {
      return res.json({ success: false, message: 'Ambulatorio non trovato' });
    }
    return res.json({ success: true, orari: amb.orari });
  }

  if (action === 'get_ambulatori_by_giorno') {
    const giorno = req.query.giorno;
    const openAmbs = ambulatori.filter(a => a.orari[giorno] && a.orari[giorno].inizio);
    return res.json({ success: true, ambulatori: openAmbs });
  }

  if (action === 'generate_slots') {
    return res.json({ success: true, count: 50 });
  }

  return res.json({ success: false, message: 'Azione non valida' });
});

// API Endpoint 2: Authentication
app.all('/backend/api/auth.php', (req, res) => {
  const action = req.query.action || '';

  if (action === 'login') {
    const { email, password } = req.body || {};
    if (email === CONFIG.admin_email && password === CONFIG.admin_password) {
      const user = {
        id: 0,
        nome: 'Amministratore',
        cognome: 'Sistema',
        email,
        is_admin: true
      };
      return res.json({
        success: true,
        token: 'admin_token_' + Date.now(),
        user
      });
    } else {
      return res.json({
        success: false,
        message: 'Credenziali non valide. Riprova.'
      });
    }
  }

  if (action === 'register') {
    const { nome, cognome, email, telefono } = req.body || {};
    const newUser = {
      id: nextPatientId++,
      nome: nome || 'Utente',
      cognome: cognome || 'Nuovo',
      email: email || '',
      telefono: telefono || '',
      num_prenotazioni: 0
    };
    pazienti.push(newUser);
    return res.json({
      success: true,
      token: 'user_token_' + Date.now(),
      user: newUser,
      message: 'Registrazione completata con successo!'
    });
  }

  if (action === 'google_auth') {
    return res.json({
      success: true,
      token: 'google_token_' + Date.now(),
      user: { id: 2, nome: 'Google', cognome: 'User', email: 'google.user@example.com' }
    });
  }

  if (action === 'apple_auth') {
    return res.json({
      success: true,
      token: 'apple_token_' + Date.now(),
      user: { id: 3, nome: 'Apple', cognome: 'User', email: 'apple.user@example.com' }
    });
  }

  if (action === 'verify') {
    return res.json({
      success: true,
      user: { id: 1, nome: 'Utente', cognome: 'Demo', email: 'utente.demo@example.com' }
    });
  }

  if (action === 'logout') {
    return res.json({ success: true });
  }

  return res.json({ success: false, message: 'Azione non valida' });
});

// API Endpoint 3: Prenotazioni
app.all('/backend/api/prenotazioni.php', async (req, res) => {
  const action = req.query.action || '';

  if (action === 'get_slots') {
    const date = req.query.date;
    const ambulatorioId = req.query.ambulatorio_id;
    if (!date) {
      return res.json({ success: false, message: 'Data non specificata' });
    }
    const slots = getSlotsForDate(date, ambulatorioId);
    return res.json({ success: true, slots });
  }

  if (action === 'create_booking') {
    const data = req.body || {};
    const { slot_id, nome, cognome, email, telefono, problema, googleToken, paziente_id } = data;

    let targetPaziente = null;
    if (paziente_id) {
      targetPaziente = pazienti.find(p => p.id == paziente_id);
    }

    if (!targetPaziente && (email || telefono)) {
      targetPaziente = pazienti.find(p => (email && p.email === email) || (telefono && p.telefono === telefono));
    }

    if (!targetPaziente && (nome || cognome)) {
      targetPaziente = {
        id: nextPatientId++,
        nome: nome || 'Paziente',
        cognome: cognome || 'Nuovo',
        email: email || '',
        telefono: telefono || '',
        num_prenotazioni: 0
      };
      pazienti.push(targetPaziente);
    }

    if (targetPaziente) {
      targetPaziente.num_prenotazioni = (targetPaziente.num_prenotazioni || 0) + 1;
      if (nome) targetPaziente.nome = nome;
      if (cognome) targetPaziente.cognome = cognome;
      if (email) targetPaziente.email = email;
      if (telefono) targetPaziente.telefono = telefono;
    }

    let slotDate = data.date || todayStr;
    let oraInizio = data.ora ? (data.ora.length <= 5 ? data.ora + ':00' : data.ora) : '10:30:00';
    // Calcola oraFine (30 min dopo)
    let [h, m, s] = oraInizio.split(':').map(Number);
    let endDate = new Date(1970, 0, 1, h, m, s || 0);
    endDate.setMinutes(endDate.getMinutes() + 30);
    let oraFine = `${String(endDate.getHours()).padStart(2, '0')}:${String(endDate.getMinutes()).padStart(2, '0')}:00`;
    
    let ambId = 1;
    let ambNome = 'Ambulatorio di Arceto';
    let ambIndirizzo = 'Via Piazza Castello, 10 - Arceto';
    
    if (data.ambulatorio) {
        if (data.ambulatorio.toLowerCase().includes('arceto')) {
            ambId = 1;
            ambNome = 'Ambulatorio di Arceto';
            ambIndirizzo = 'Via Piazza Castello, 10 - Arceto';
        } else if (data.ambulatorio.toLowerCase().includes('casalgrande')) {
            ambId = 2;
            ambNome = 'Ambulatorio di Casalgrande';
            ambIndirizzo = 'Via Canale, 29 - Casalgrande';
        }
    } else if (slot_id) {
      ambId = Math.floor(Number(slot_id) / 1000) || 1;
      const foundAmb = ambulatori.find(a => a.id === ambId);
      if (foundAmb) {
        ambNome = foundAmb.nome;
        ambIndirizzo = foundAmb.indirizzo;
      }
    }

    const newBooking = {
      id: nextBookingId++,
      slot_id: slot_id || 101,
      data_slot: slotDate,
      ora_inizio: oraInizio,
      ora_fine: oraFine,
      ambulatorio_id: ambId,
      ambulatorio_nome: ambNome,
      ambulatorio_indirizzo: ambIndirizzo,
      paziente_id: targetPaziente ? targetPaziente.id : null,
      paziente_nome: targetPaziente ? targetPaziente.nome : (nome || 'Ospite'),
      paziente_cognome: targetPaziente ? targetPaziente.cognome : (cognome || ''),
      paziente_telefono: targetPaziente ? targetPaziente.telefono : (telefono || ''),
      paziente_email: targetPaziente ? targetPaziente.email : (email || ''),
      problema: problema || 'Visita medica generale',
      stato: 'confermata',
      evento_calendar_id: add_to_calendar ? ('evt_' + Date.now()) : null,
      cancellato_da: null,
      data_cancellazione: null
    };

    prenotazioni.push(newBooking);

    if (googleToken) {
      newBooking.evento_calendar_id = await createGoogleCalendarEvent(newBooking, googleToken);
    }

    // Invia email di conferma al paziente e notifica all'amministratore
    const adminEmail = 'valeriabraglia62@gmail.com';
    const patientEmail = newBooking.paziente_email;
    const dateFormatted = new Date(newBooking.data_slot).toLocaleDateString('it-IT');
    
    // Email per l'amministratore
    const adminMailOptions = {
      from: process.env.EMAIL_USER || 'no-reply@medprenotazioni.com',
      to: adminEmail,
      subject: `Nuova prenotazione da ${newBooking.paziente_nome} ${newBooking.paziente_cognome}`,
      text: `Hai ricevuto una nuova prenotazione.\n\nDettagli Paziente:\nNome: ${newBooking.paziente_nome} ${newBooking.paziente_cognome}\nEmail: ${newBooking.paziente_email}\nTelefono: ${newBooking.paziente_telefono}\nMotivo: ${newBooking.problema}\n\nDettagli Appuntamento:\nData: ${dateFormatted}\nOra: ${newBooking.ora_inizio}\nAmbulatorio: ${newBooking.ambulatorio_nome} (${newBooking.ambulatorio_indirizzo})`
    };

    if (hasRealEmailConfig) {
      transporter.sendMail(adminMailOptions).catch(err => console.error('Errore invio email admin:', err));
    } else {
      console.log('Simulazione invio email admin:', adminMailOptions.subject);
    }

    // Email per il paziente
    if (patientEmail) {
      const patientMailOptions = {
        from: process.env.EMAIL_USER || 'no-reply@medprenotazioni.com',
        to: patientEmail,
        subject: 'Conferma Prenotazione Medica',
        text: `Gentile ${newBooking.paziente_nome},\n\nLa tua prenotazione è stata confermata con successo.\n\nDettagli Appuntamento:\nData: ${dateFormatted}\nOra: ${newBooking.ora_inizio}\nAmbulatorio: ${newBooking.ambulatorio_nome}\nIndirizzo: ${newBooking.ambulatorio_indirizzo}\nMotivo: ${newBooking.problema}\n\nGrazie,\nLo staff di MedPrenotazioni`
      };
      if (hasRealEmailConfig) {
        transporter.sendMail(patientMailOptions).catch(err => console.error('Errore invio email paziente:', err));
      } else {
        console.log('Simulazione invio email paziente:', patientMailOptions.subject);
      }
    }

    return res.json({
      success: true,
      message: 'Prenotazione creata con successo',
      prenotazione_id: newBooking.id,
      event_id: newBooking.evento_calendar_id
    });
  }

  if (action === 'cancel_booking') {
    const bookingId = req.body?.id || req.query.id;
    const googleToken = req.body?.googleToken;
    const found = prenotazioni.find(p => p.id == bookingId);
    if (found) {
      found.stato = 'annullata';
      found.cancellato_da = 'paziente';
      found.data_cancellazione = new Date().toISOString();

      if (found.evento_calendar_id && googleToken) {
        await deleteGoogleCalendarEvent(found.evento_calendar_id, googleToken);
      }

      // Invia email di annullamento con file ICS per rimuovere dal calendario
      const adminEmail = 'valeriabraglia62@gmail.com';
      const patientEmail = found.paziente_email;
      const dateFormatted = new Date(found.data_slot).toLocaleDateString('it-IT');
      
      const adminMailOptions = {
        from: process.env.EMAIL_USER || 'no-reply@medprenotazioni.com',
        to: adminEmail,
        subject: `Annullamento prenotazione - ${found.paziente_nome} ${found.paziente_cognome}`,
        text: `Il paziente ha annullato la prenotazione.\n\nDettagli Appuntamento:\nData: ${dateFormatted}\nOra: ${found.ora_inizio}\nAmbulatorio: ${found.ambulatorio_nome}`
      };
      
      if (hasRealEmailConfig) transporter.sendMail(adminMailOptions).catch(err => console.error(err));

      if (patientEmail) {
        const patientMailOptions = {
          from: process.env.EMAIL_USER || 'no-reply@medprenotazioni.com',
          to: patientEmail,
          subject: 'Annullamento Prenotazione Medica',
          text: `Gentile ${found.paziente_nome},\n\nTi confermiamo l'annullamento della tua prenotazione per il giorno ${dateFormatted} alle ore ${found.ora_inizio} presso l'Ambulatorio: ${found.ambulatorio_nome}.\n\nCordiali saluti,\nLo staff di MedPrenotazioni`
        };
        if (hasRealEmailConfig) transporter.sendMail(patientMailOptions).catch(err => console.error(err));
      }

      return res.json({ success: true, message: 'Prenotazione annullata con successo' });
    }
    return res.json({ success: false, message: 'Prenotazione non trovata' });
  }

  if (action === 'get_all') {
    let result = [...prenotazioni];

    if (req.query.search) {
      const q = req.query.search.toLowerCase();
      result = result.filter(p => 
        (p.paziente_nome && p.paziente_nome.toLowerCase().includes(q)) ||
        (p.paziente_cognome && p.paziente_cognome.toLowerCase().includes(q)) ||
        (p.paziente_telefono && p.paziente_telefono.includes(q)) ||
        (p.problema && p.problema.toLowerCase().includes(q))
      );
    }

    if (req.query.ambulatorio) {
      result = result.filter(p => p.ambulatorio_id == req.query.ambulatorio);
    }

    if (req.query.data) {
      result = result.filter(p => p.data_slot === req.query.data);
    }

    return res.json({
      success: true,
      prenotazioni: result,
      pagination: { current_page: 1, total_pages: 1 }
    });
  }

  if (action === 'get_details') {
    const bookingId = req.query.id;
    const found = prenotazioni.find(p => p.id == bookingId);
    if (found) {
      return res.json({ success: true, prenotazione: found });
    }
    return res.json({ success: false, message: 'Prenotazione non trovata' });
  }

  if (action === 'get_user_bookings') {
    return res.json({ success: true, prenotazioni });
  }

  return res.json({ success: false, message: 'Azione non valida' });
});

// API Endpoint 4: Dashboard Stats
app.all('/backend/api/dashboard.php', (req, res) => {
  const activeBookings = prenotazioni.filter(p => p.stato === 'confermata');
  const oggiCount = activeBookings.filter(p => p.data_slot === todayStr).length;

  const tomObj = new Date();
  tomObj.setDate(tomObj.getDate() + 1);
  const tomStr = tomObj.toISOString().split('T')[0];
  const domaniCount = activeBookings.filter(p => p.data_slot === tomStr).length;

  const arcetoCount = activeBookings.filter(p => p.ambulatorio_id === 1).length;
  const casalgrandeCount = activeBookings.filter(p => p.ambulatorio_id === 2).length;

  return res.json({
    success: true,
    stats: {
      oggi: oggiCount,
      domani: domaniCount,
      settimana: activeBookings.length,
      pazienti: pazienti.length
    },
    charts: {
      ambulatori: {
        labels: ['Arceto', 'Casalgrande'],
        data: [arcetoCount, casalgrandeCount]
      },
      giorni: {
        labels: ['Lun', 'Mar', 'Mer', 'Gio', 'Ven'],
        data: [2, 1, 3, 2, 1]
      }
    },
    prenotazioni_recenti: prenotazioni.slice(0, 5)
  });
});

// API Endpoint 5: Pazienti
app.all('/backend/api/pazienti.php', (req, res) => {
  const action = req.query.action || '';

  if (action === 'get_all') {
    let result = [...pazienti];
    if (req.query.search) {
      const q = req.query.search.toLowerCase();
      result = result.filter(p =>
        (p.nome && p.nome.toLowerCase().includes(q)) ||
        (p.cognome && p.cognome.toLowerCase().includes(q)) ||
        (p.email && p.email.toLowerCase().includes(q)) ||
        (p.telefono && p.telefono.includes(q))
      );
    }
    return res.json({
      success: true,
      pazienti: result,
      pagination: { current_page: 1, total_pages: 1 }
    });
  }

  if (action === 'get_details') {
    const pazienteId = req.query.id;
    const found = pazienti.find(p => p.id == pazienteId);
    if (found) {
      const userBookings = prenotazioni.filter(p => p.paziente_id == pazienteId);
      return res.json({
        success: true,
        paziente: { ...found, prenotazioni: userBookings }
      });
    }
    return res.json({ success: false, message: 'Paziente non trovato' });
  }

  if (action === 'update') {
    const { id, nome, cognome, email, telefono } = req.body || {};
    const found = pazienti.find(p => p.id == id);
    if (found) {
      if (nome) found.nome = nome;
      if (cognome) found.cognome = cognome;
      if (email) found.email = email;
      if (telefono) found.telefono = telefono;
      return res.json({ success: true, message: 'Paziente aggiornato con successo' });
    }
    return res.json({ success: false, message: 'Paziente non trovato' });
  }

  return res.json({ success: false, message: 'Azione non valida' });
});

// API Endpoint 6: Settings
app.all('/backend/api/settings.php', (req, res) => {
  if (req.body && req.body.admin_password) {
    CONFIG.admin_password = req.body.admin_password;
  }
  return res.json({ success: true, message: 'Impostazioni salvate' });
});

// Serve Static Files
app.use(express.static(__dirname));

// Start Server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
