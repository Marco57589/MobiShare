document.addEventListener('DOMContentLoaded', function initMap() {
    // Definisci la posizione di Vercelli
    const vercelliLocation = [45.325000, 8.42500]; // Latitudine e longitudine

    // Inizializza la mappa centrata su Vercelli
    const map = L.map('map-container').setView(vercelliLocation, 14);

    // Aggiungi il layer della mappa da OpenStreetMap
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);


    const parcheggiElement = document.getElementById('parcheggi-data');
    const parcheggi = JSON.parse(parcheggiElement.getAttribute('data-parcheggi')); 

    parcheggi.forEach(parcheggio => {
        const marker = L.marker([parcheggio.latitudine, parcheggio.longitudine]).addTo(map);
        marker.bindPopup(`
            <b>${parcheggio.nome}</b><br>
            ${parcheggio.via}<br>
            Mezzi disponibili: ${parcheggio.mezziDisponibili}
        `);
    });

});