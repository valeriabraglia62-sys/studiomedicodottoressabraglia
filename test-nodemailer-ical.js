import nodemailer from 'nodemailer';
const mailOptions = {
  from: 'test@example.com',
  to: 'test2@example.com',
  subject: 'Test ICS',
  text: 'Hello',
  icalEvent: {
    filename: 'invite.ics',
    method: 'request',
    content: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//sebbo.net//ical-generator//EN\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:123\r\nDTSTAMP:20260728T074815Z\r\nDTSTART:20260728T103000Z\r\nSUMMARY:Test\r\nEND:VEVENT\r\nEND:VCALENDAR'
  }
};
console.log(mailOptions);
