const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs-extra');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const BODOVI_FILE = './bodovi.json';
const MASTER_TAJNA_SIFRA = "ARENA2026"; 
const PSOVKE = ["psovka1", "psovka2", "idiot", "majmun"]; 

app.use(express.static('.'));
app.use(express.json());

let trenutnoPitanje = null;
let odgovorenoPuta = 0;
let tajmerInterval = null;
let aktivnaKategorija = "";

// --- FUNKCIJA ZA BODOVANJE ---
async function azurirajBodove(nadimak, osvojeniBodovi, kategorija) {
    try {
        const baza = await fs.readJson(BODOVI_FILE);
        let korisnik = baza.korisnici.find(u => u.nadimak === nadimak);
        if (korisnik) {
            if (!korisnik.ukupni_bodovi) korisnik.ukupni_bodovi = 0;
            korisnik.ukupni_bodovi += osvojeniBodovi;
        }

        if (!baza.kategorije_stats[kategorija]) baza.kategorije_stats[kategorija] = [];
        let katStat = baza.kategorije_stats[kategorija].find(s => s.nadimak === nadimak);
        if (!katStat) {
            baza.kategorije_stats[kategorija].push({ nadimak: nadimak, bodovi: osvojeniBodovi });
        } else {
            katStat.bodovi += osvojeniBodovi;
        }

        const tipovi = ['dnevni', 'tjedni', 'mjesecni', 'ukupno'];
        tipovi.forEach(tip => {
            if (!baza.leaderboard[tip]) baza.leaderboard[tip] = [];
            let lb = baza.leaderboard[tip].find(l => l.nadimak === nadimak);
            if (!lb) {
                baza.leaderboard[tip].push({ nadimak: nadimak, bodovi: osvojeniBodovi });
            } else {
                lb.bodovi += osvojeniBodovi;
            }
            baza.leaderboard[tip].sort((a, b) => b.bodovi - a.bodovi);
        });

        await fs.writeJson(BODOVI_FILE, baza, { spaces: 2 });
    } catch (err) {
        console.error("Greška pri ažuriranju bodova:", err);
    }
}

// --- SOCKET LOGIKA ---
io.on('connection', (socket) => {
    socket.on('prijava', async (podaci) => {
        try {
            const baza = await fs.readJson(BODOVI_FILE);
            let korisnik = baza.korisnici.find(u => u.nadimak === podaci.nadimak);

            if (korisnik && korisnik.banovanDo && korisnik.banovanDo > Date.now()) {
                const preostalo = new Date(korisnik.banovanDo).toLocaleString('hr-HR');
                return socket.emit('ban_info', `Zabranjen pristup. Ban istječe: ${preostalo}`);
            }

            if (!korisnik) {
                korisnik = { 
                    nadimak: podaci.nadimak, 
                    lozinka: podaci.lozinka, 
                    tajna_sifra: podaci.tajna_sifra, 
                    opomene: 0, 
                    banovanDo: null,
                    ukupni_bodovi: 0 
                };
                baza.korisnici.push(korisnik);
                await fs.writeJson(BODOVI_FILE, baza);
            }

            if (korisnik.lozinka !== podaci.lozinka) {
                return socket.emit('obavijest', "Pogrešna lozinka!");
            }

            socket.nadimak = korisnik.nadimak;
            socket.emit('prijavljen', { nadimak: korisnik.nadimak });
        } catch (err) {
            console.error("Greška pri prijavi:", err);
        }
    });

    socket.on('start_kviz', async (kat) => {
        try {
            const putanja = `./pitanja/${kat}.json`;
            const pitanja = await fs.readJson(putanja);
            aktivnaKategorija = kat;
            trenutnoPitanje = pitanja[Math.floor(Math.random() * pitanja.length)];
            odgovorenoPuta = 0;
            io.emit('novo_pitanje', { pitanje: trenutnoPitanje.pitanje });
            pokreniTajmer();
        } catch (e) {
            socket.emit('obavijest', "Kategorija još nema pitanja!");
        }
    });

    socket.on('slanje_odgovora', async (odgovor) => {
        if (!trenutnoPitanje || !socket.nadimak) return;
        const msg = odgovor.toLowerCase().trim();
        const baza = await fs.readJson(BODOVI_FILE);
        let korisnik = baza.korisnici.find(u => u.nadimak === socket.nadimak);

        if (PSOVKE.some(p => msg.includes(p))) {
            korisnik.opomene++;
            if (korisnik.opomene >= 2) {
                korisnik.banovanDo = Date.now() + (24 * 60 * 60 * 1000);
                await fs.writeJson(BODOVI_FILE, baza);
                socket.emit('ban_info', `BAN na 24h zbog psovanja.`);
                return socket.disconnect();
            }
            await fs.writeJson(BODOVI_FILE, baza);
            return socket.emit('obavijest', "⚠️ PRVO UPOZORENJE! Zabranjeno psovanje.");
        }

        const tocan = trenutnoPitanje.odgovor.toLowerCase().trim();
        if (msg === tocan) {
            odgovorenoPuta++;
            let bodovi = (odgovorenoPuta === 1) ? 7 : 5;
            await azurirajBodove(socket.nadimak, bodovi, aktivnaKategorija);
            socket.emit('rezultat_odgovora', { točno: true, osvojeno: bodovi });
        } else {
            await azurirajBodove(socket.nadimak, -2, aktivnaKategorija);
            socket.emit('rezultat_odgovora', { točno: false, osvojeno: -2 });
        }
    });
});

function pokreniTajmer() {
    clearInterval(tajmerInterval);
    let sekunde = 30;
    tajmerInterval = setInterval(() => {
        io.emit('vrijeme', sekunde);
        if (sekunde <= 0) {
            clearInterval(tajmerInterval);
            io.emit('kraj_pitanja');
            trenutnoPitanje = null;
        }
        sekunde--;
    }, 1000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server na portu ${PORT}`));