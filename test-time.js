let ora = '10:30';
let oraInizio = ora ? (ora.length <= 5 ? ora + ':00' : ora) : '10:30:00';
console.log(oraInizio);
