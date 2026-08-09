import * as ics from 'ics';
const event = {
  start: [2026, 7, 28, 10, 30],
  duration: { hours: 1 },
  title: 'Test',
  method: 'REQUEST',
  uid: 'test-12345'
}
ics.createEvent(event, (error, value) => {
  console.log(value)
})
