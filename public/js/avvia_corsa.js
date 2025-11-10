"use strict";

document.addEventListener('DOMContentLoaded', () => {
	const select = document.getElementById('parcheggio');
	const mezziCards = document.querySelectorAll('.mezzo-card');
	const noMezziText = document.getElementById('no-mezzi');
	const form = document.querySelector('form');
	const erroreBox = document.getElementById('errore-corsa');
	const submitBtn = form.querySelector('button[type="submit"]');
	
	function filterMezzi() {
		const selectedId = select.value;
		let mezzi = 0;
		mezziCards.forEach(card => {
			if(card.dataset.parcheggio === selectedId) {
				card.style.display = 'block';
				mezzi++;
			}
			else {
				card.style.display = 'none';
			}
			noMezziText.style.display = mezzi === 0 ? 'block' : 'none';
		});
	}
	
	select.addEventListener('change', filterMezzi);
	filterMezzi();
	
	form.addEventListener('submit', (e) => {
		const selected = document.querySelector('input[name="mezzoId"]:checked');
		
		if (!selected) {
			e.preventDefault();
			erroreBox.style.display = 'block';
		} else {
			erroreBox.style.display = 'none';
			submitBtn.disabled = true;
		}
	});
	
	document.querySelectorAll('input[name="mezzoId"]').forEach(radio => {
		radio.addEventListener('change', () => {
			if (submitBtn.disabled) {
				submitBtn.disabled = false;
			}
			erroreBox.style.display = 'none';
		});
	});
	
	select.addEventListener('change', () => {
		if (submitBtn.disabled) {
			submitBtn.disabled = false;
		}
		erroreBox.style.display = 'none';
	});
});