const admin = require('firebase-admin');

async function updateVehicleStatus(mezzoId, status) {
	try {
		
		const mezziSnap = await admin.firestore()
			.collection('mezzi')
			.where('id', '==', Number(mezzoId))
			.limit(1)
			.get();
		
		if (!mezziSnap.empty) {
			await mezziSnap.docs[0].ref.update({
				stato: status,
				ultimoAggiornamento: admin.firestore.FieldValue.serverTimestamp()
			});
			
			if (global.aedesInstance) {
				const statoMessage = {
					mezzoId: Number(mezzoId),
					stato: status,
					timestamp: new Date().toISOString(),
					source: 'firestore_sync'
				};
				
				global.aedesInstance.publish({
					topic: 'mobishare/mezzi/stato',
					payload: JSON.stringify(statoMessage)
				});
			}
			
			return true;
		}
		return false;
	} catch (error) {
		console.error(`Errore aggiornamento mezzo ${mezzoId}:`, error);
		return false;
	}
}

async function verificaPrenotazione(userId, mezzoId) {
	try {
		// Verifica credito utente
		const userDoc = await admin.firestore().collection('users').doc(userId).get();
		if (!userDoc.exists) return false;
		
		const userData = userDoc.data();
		if (userData.saldo <= 0 || userData.stato_profilo === 'sospeso') {
			return false;
		}
		
		// Verifica disponibilità mezzo
		const mezziSnap = await admin.firestore()
			.collection('mezzi')
			.where('id', '==', Number(mezzoId))
			.limit(1)
			.get();
		
		if (mezziSnap.empty) return false;
		
		const mezzo = mezziSnap.docs[0].data();
		if (mezzo.stato !== 'Disponibile') return false;
		
		if (mezzo.isElettrico && (mezzo.batteria || 0) < 10) {
			return false;
		}
		
		return true;
	} catch (error) {
		console.error('Errore verifica prenotazione:', error);
		return false;
	}
}

async function updateVehicleBattery(mezzoId, batteria) {
	try{
		const mezziSnap = await admin.firestore()
			.collection('mezzi')
			.where('id', '==', Number(mezzoId))
			.limit(1)
			.get()

		if (!mezziSnap.empty) {
			await mezziSnap.docs[0].ref.update({
				batteria: Number(batteria),
				ultimoAggiornamento: admin.firestore.FieldValue.serverTimestamp()
			});
			if (global.aedesInstance) {
				const statoMessage = {
					mezzoId: Number(mezzoId),
					batteria: Number(batteria),
					timestamp: new Date().toISOString(),
					source: 'firestore_sync'
				};
			
				global.aedesInstance.publish({
					topic: 'mobishare/mezzi/batteria',
					payload: JSON.stringify(statoMessage)
				});
			}
			return true;
		}
		return false;
	} catch (error) {
		console.error(`Errore aggiornamento mezzo ${mezzoId}:`, error);
		return false;
	}
}


module.exports = {
	updateVehicleStatus,
	verificaPrenotazione,
	updateVehicleBattery
};

