document.addEventListener('DOMContentLoaded', function () {
	const form = document.getElementById('formModificaProfilo');
	const password = document.getElementById('password');
	const confirmPassword = document.getElementById('confirmPassword');
	
	form.addEventListener('submit', function (e) {
		if (password.value && password.value.length < 8) {
			e.preventDefault();
			alert('La password deve contenere almeno 8 caratteri');
			return false;
		}
		
		if (password.value !== confirmPassword.value) {
			e.preventDefault();
			alert('Le password non coincidono');
			return false;
		}
	});
	
	const urlParams = new URLSearchParams(window.location.search);
	if (urlParams.has('success')) {
		alert('Profilo aggiornato con successo!');
	}
	
	document.querySelector('.delete-face-btn')?.addEventListener('click', () => {
		const modal = new bootstrap.Modal(document.getElementById('passwordVerificationModal'));
		modal.show();
	});
});

async function verifyAndDeleteFace() {
	const passwordInput = document.getElementById('password');
	const passwordError = document.getElementById('passwordError');
	const password = passwordInput.value.trim();
	
	passwordError.classList.add('d-none');
	passwordError.textContent = '';
	
	if (!password) {
		passwordError.textContent = 'Inserisci la password.';
		passwordError.classList.remove('d-none');
		return;
	}
	
	try {
		const verifyResponse = await fetch('/api/verify-password', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ password })
		});
		
		const verifyData = await verifyResponse.json();
		
		if (!verifyResponse.ok || !verifyData.success) {
			passwordError.textContent = verifyData.error || 'Password errata.';
			passwordError.classList.remove('d-none');
			return;
		}
		
		const deleteResponse = await fetch('/api/face-recognition/delete', {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json' }
		});
		
		const deleteData = await deleteResponse.json();
		
		if (deleteResponse.ok && deleteData.success) {
			const modal = bootstrap.Modal.getInstance(document.getElementById('passwordVerificationModal'));
			modal.hide();
			setTimeout(() => location.reload(), 1000);
		} else {
			passwordError.textContent = deleteData.error || 'Errore durante l\'eliminazione.';
			passwordError.classList.remove('d-none');
		}
		
	} catch (error) {
		console.error('Errore durante la verifica/eliminazione:', error);
		passwordError.textContent = 'Errore di connessione.';
		passwordError.classList.remove('d-none');
	}
}
