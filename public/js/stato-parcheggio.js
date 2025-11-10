document.addEventListener('DOMContentLoaded', function () {
    // Recupera i dati dei parcheggi e mezzi dal backend
    const parcheggiDiv = document.getElementById('parcheggi-data');
    const parcheggioPartenza = document.getElementById('parcheggio_partenza');
    const mezzoSelect = document.getElementById('mezzo_id');

    const parcheggi = JSON.parse(parcheggiDiv.getAttribute('data-parcheggi'));

    if (parcheggioPartenza && mezzoSelect) {
        parcheggioPartenza.addEventListener('change', function () {
            const selectedId = this.value;
            console.log('Selected parcheggio ID:', selectedId);
            mezzoSelect.innerHTML = '';
            mezzoSelect.disabled = true;

            if (!selectedId) {
                mezzoSelect.innerHTML = '<option value="">Seleziona un parcheggio</option>';
                return;
            }

            const parcheggio = parcheggi.find(p => String(p.id) === String(selectedId));
            console.log('Selected parcheggio:', parcheggio);
            if (parcheggio && parcheggio.mezzi && parcheggio.mezzi.length > 0) {
                mezzoSelect.disabled = false;
                mezzoSelect.innerHTML = '<option value="">Seleziona...</option>';
                parcheggio.mezzi.forEach(mezzo => {
                    mezzoSelect.innerHTML += `<option value="${mezzo.id}">${mezzo.tipo} #${mezzo.id}</option>`;
                });
            } else {
                mezzoSelect.innerHTML = '<option value="">Nessun mezzo disponibile</option>';
            }
        });
    }
});