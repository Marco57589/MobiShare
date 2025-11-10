const admin = require('firebase-admin');
const path = require('path');
const serviceAccount = require(path.join(__dirname, 'serviceAccountKey.json'));

admin.initializeApp({
	credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const BATCH_SIZE = 500;

class MobiShareRideGenerator {
	constructor() {
		this.parcheggi = [
			{id: 1, nome: "Asia", capacita: 4},
			{id: 2, nome: "Giulia", capacita: 4},
			{id: 3, nome: "Magenta", capacita: 4},
			{id: 4, nome: "Matteo", capacita: 4}
		];
		
		this.mezziDisponibili = [
			{tipo: 'Monopattino Elettrico', elettrico: true},
			{tipo: 'Bicicletta Elettrica', elettrico: true},
			{tipo: 'Bicicletta', elettrico: false}
		];
		
		this.stati = ['completata', 'completata_automatica'];
		this.mezzi = [];
		this.rides = [];
		this.feedbacks = [
			// Positivi
			"Viaggio fantastico, mezzo in ottime condizioni.",
			"Molto comodo e veloce, esperienza super positiva.",
			"Facile da usare e servizio eccellente.",
			"Il modo migliore per muoversi in città, lo userò ancora.",
			"Tutto perfetto, dalla prenotazione alla restituzione.",
			// Neutri
			"Servizio nella media, niente di eccezionale.",
			"Il viaggio è andato bene, ma il mezzo era un po' usurato.",
			"Disponibilità dei mezzi sufficiente.",
			"Buono per brevi spostamenti, ma non per lunghe distanze.",
			"Esperienza ok, senza infamia e senza lode.",
			// Negativi
			"Mezzo sporco e malfunzionante, esperienza negativa.",
			"Non ci sono mai mezzi disponibili, ho dovuto aspettare ore.",
			"Costo eccessivo per la qualità del servizio offerto.",
			"Ho trovato il mezzo scarico e rotto.",
			"Pessima esperienza, non credo che lo userò di nuovo."
		];
	}
	
	inizializzaMezzi() {
		this.mezzi = Array.from({length: 16}, (_, i) => {
			const tipo = this.mezziDisponibili[Math.floor(Math.random() * this.mezziDisponibili.length)];
			const parcheggioId = (i % 4) + 1;
			
			return {
				id: i + 1,
				tipo: tipo.tipo,
				elettrico: tipo.elettrico,
				id_parcheggio: parcheggioId,
				stato: 'Disponibile',
				storico: []
			};
		});
	}
	
	getMezziDisponibiliInParcheggio(parcheggioId) {
		return this.mezzi.filter(m => m.id_parcheggio === parcheggioId && m.stato === 'Disponibile');
	}
	
	prendiMezzo(parcheggioId, userId) {
		const mezziDisponibili = this.getMezziDisponibiliInParcheggio(parcheggioId);
		if (mezziDisponibili.length === 0) return null;
		
		const mezzo = mezziDisponibili[Math.floor(Math.random() * mezziDisponibili.length)];
		mezzo.stato = 'In uso';
		mezzo.ultimoUtente = userId;
		mezzo.ultimoPrelievo = new Date();
		mezzo.ultimoParcheggio = parcheggioId;
		
		return mezzo;
	}
	
	restituisciMezzo(mezzoId, parcheggioArrivoId, userId) {
		const mezzo = this.mezzi.find(m => m.id === mezzoId);
		if (!mezzo) return false;
		
		mezzo.stato = 'Disponibile';
		mezzo.id_parcheggio = parcheggioArrivoId;
		mezzo.ultimaRestituzione = new Date();
		
		if (mezzo.ultimoPrelievo) {
			mezzo.storico.push({
				utente: userId,
				prelievo: mezzo.ultimoPrelievo.toISOString(),
				restituzione: mezzo.ultimaRestituzione.toISOString(),
				parcheggioPartenza: mezzo.ultimoParcheggio || null,
				parcheggioArrivo: parcheggioArrivoId
			});
		}
		
		delete mezzo.ultimoPrelievo;
		delete mezzo.ultimoUtente;
		delete mezzo.ultimoParcheggio;
		return true;
	}
	
	generaCorsaSimulata(rideId, giorno) {
		const startTime = this.generaOrarioCorsa(giorno);
		const parcheggioPartenzaId = this.scegliParcheggioPartenza(startTime);
		const userId = `user_${Math.ceil(Math.random() * 10)}`;
		const mezzo = this.prendiMezzo(parcheggioPartenzaId, userId);
		if (!mezzo) return null;
		
		const durataMinuti = Math.floor(Math.random() * 45) + 5;
		const endTime = new Date(startTime.getTime() + durataMinuti * 60 * 1000);
		let parcheggioArrivoId;
		
		do {
			parcheggioArrivoId = this.parcheggi[Math.floor(Math.random() * this.parcheggi.length)].id;
		} while (parcheggioArrivoId === parcheggioPartenzaId && this.parcheggi.length > 1);
		
		const status = this.stati[Math.floor(Math.random() * this.stati.length)];
		const costo = parseFloat((Math.random() * 6 + 0.5).toFixed(2));
		this.restituisciMezzo(mezzo.id, parcheggioArrivoId, userId);
		
		const ride = {
			id: rideId,
			userId,
			mezzoId: mezzo.id,
			mezzoTipo: mezzo.tipo,
			mezzoElettrico: mezzo.elettrico,
			parcheggioPartenza: parcheggioPartenzaId,
			parcheggioArrivo: parcheggioArrivoId,
			startTime: startTime.toISOString(),
			endTime: endTime.toISOString(),
			durataMinuti,
			costo,
			puntiCorsa: Number((costo * 0.1 + 1).toFixed(2)),
			status
		};
		
		if (Math.random() < 0.3) {
			ride.feedback = this.feedbacks[Math.floor(Math.random() * this.feedbacks.length)];
		}
		
		return ride;
	}
	
	
	scegliParcheggioPartenza(giorno) {
		const ora = giorno.getHours();
		let pesi;
		
		if (ora >= 7 && ora < 12) {
			// mattina: parcheggi 1 e 2 più popolari (vicino uffici)
			pesi = [0.4, 0.4, 0.1, 0.1];
		} else if (ora >= 12 && ora < 18) {
			// pomeriggio: distribuzione uniforme
			pesi = [0.3, 0.3, 0.2, 0.2];
		} else if (ora >= 18 && ora < 23) {
			// sera: parcheggi 3 e 4 più popolari (zone residenziali)
			pesi = [0.1, 0.1, 0.4, 0.4];
		} else {
			// notte: distribuzione casuale
			pesi = [0.25, 0.25, 0.25, 0.25];
		}
		
		const random = Math.random();
		let accumulo = 0;
		for (let i = 0; i < pesi.length; i++) {
			accumulo += pesi[i];
			if (random <= accumulo) return this.parcheggi[i].id;
		}
		return this.parcheggi[0].id;
	}
	
	generaOrarioCorsa(giorno) {
		const data = new Date(giorno);
		const r = Math.random();
		let hour;
		
		if (r < 0.35) { // 35% mattina (7-12)
			hour = 7 + Math.floor(Math.random() * 6);
		} else if (r < 0.65) { // 30% pomeriggio (12-18)
			hour = 12 + Math.floor(Math.random() * 6);
		} else if (r < 0.90) { // 25% sera (18-23)
			hour = 18 + Math.floor(Math.random() * 6);
		} else { // 10% notte (0-6)
			hour = Math.floor(Math.random() * 6);
		}
		
		data.setHours(hour);
		data.setMinutes(Math.floor(Math.random() * 60));
		data.setSeconds(Math.floor(Math.random() * 60));
		return data;
	}
	
	simulaGiornata(giorno, corsePerGiorno) {
		const corseGiorno = [];
		for (let i = 0; i < corsePerGiorno; i++) {
			const rideId = `ride_${giorno.toISOString().split('T')[0]}_${i}_${Math.random().toString(36).substr(2, 9)}`;
			const corsa = this.generaCorsaSimulata(rideId, giorno);
			if (corsa) corseGiorno.push(corsa);
		}
		return corseGiorno;
	}
	
	generaDatiStorici(giorni = 30, corsePerGiornoMin = 100, corsePerGiornoMax = 150) {
		console.log(`Generazione di dati per ${giorni} giorni...`);
		this.inizializzaMezzi();
		const oggi = new Date();
		const tutteLeCorse = [];
		
		for (let g = 0; g < giorni; g++) {
			const dataGiorno = new Date(oggi);
			dataGiorno.setDate(oggi.getDate() - (giorni - g));
			const corseCount = Math.floor(Math.random() * (corsePerGiornoMax - corsePerGiornoMin + 1)) + corsePerGiornoMin;
			const corse = this.simulaGiornata(dataGiorno, corseCount);
			tutteLeCorse.push(...corse);
		}
		
		this.rides = tutteLeCorse;
		console.log(`Generazione completata: ${this.rides.length} corse totali`);
	}
	
	async salvaSuFirestore() {
		console.log("Scrittura su Firestore...");
		
		for (let i = 0; i < this.rides.length; i += BATCH_SIZE) {
			const batch = db.batch();
			const chunk = this.rides.slice(i, i + BATCH_SIZE);
			
			chunk.forEach(ride => {
				const docRef = db.collection('rides').doc(ride.id);
				batch.set(docRef, ride);
			});
			
			await batch.commit();
			console.log(`Batch ${i / BATCH_SIZE + 1}: ${chunk.length} corse scritte`);
		}
		console.log("Scrittura completata");
	}
}

async function popolaDb() {
	const simulator = new MobiShareRideGenerator();
	simulator.generaDatiStorici(30, 200, 200);
	await simulator.salvaSuFirestore();
	console.log("Popolamento Firestore completato!");
	process.exit(0);
}

if (require.main === module) {
	popolaDb().catch(err => {
		console.error("Errore nella popolazione:", err);
		process.exit(1);
	});
}

module.exports = MobiShareRideGenerator;