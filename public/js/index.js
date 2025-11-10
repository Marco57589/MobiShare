'use strict';
document.addEventListener('DOMContentLoaded', function() {
	const tariffeDiv = document.getElementById('tariffe-mezzi');
	const tariffe = JSON.parse(tariffeDiv.getAttribute('data-parcheggi'));
	const select = document.getElementById('tipoMezzo');
	const totaleDiv = document.getElementById('totale-ricarica');
	const btnRicarica = document.getElementById('btnRicarica');
	const saldo = parseFloat(document.getElementById('saldoUtente').value);
	
	if (select && btnRicarica) {
		let importoRicarica = 0;
		
		select.addEventListener('change', function() {
			const mezzoSelezionato = select.value;
			const tariffa = tariffe.find(t => t.mezzo === mezzoSelezionato);
			
			if (tariffa) {
				importoRicarica = tariffa.mezzora + tariffa.costoFisso + Math.abs(saldo);
				
				totaleDiv.innerHTML = `
                    <div class="alert alert-info">
                        <strong>Dettaglio ricarica:</strong><br>
                        - 30 minuti di utilizzo: ${(tariffa.mezzora + tariffa.costoFisso).toFixed(2)} €<br>
                        - Copertura saldo negativo: ${Math.abs(saldo).toFixed(2)} €<br>
                        <strong>Totale da ricaricare: ${importoRicarica.toFixed(2)} €</strong>
                    </div>
                `;
				
				btnRicarica.disabled = false;
				btnRicarica.classList.remove('btn-secondary');
				btnRicarica.classList.add('btn-success');
				
			} else {
				totaleDiv.innerHTML = '<div class="alert alert-warning">Tariffa non disponibile per questo mezzo.</div>';
				btnRicarica.disabled = true;
				btnRicarica.classList.remove('btn-success');
				btnRicarica.classList.add('btn-secondary');
			}
		});
		
		btnRicarica.addEventListener('click', function() {
			if (importoRicarica > 0) {
				window.location.href = `/gestione-credito?need=ricarica&amount=${importoRicarica.toFixed(2)}`;
			}
		});
	}
});