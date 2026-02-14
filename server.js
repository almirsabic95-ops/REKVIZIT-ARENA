const express = require('express');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 10000;
const BODOVI_FILE = path.join(__dirname, 'bodovi.json');

// Postavke
const MASTER_TAJNA_SIFRA = "ARENA2026"; 
const PSOVKE = ["psovka1", "psovka2", "idiot", "majmun"]; // Dopuni listu ovdje

app.use(express.static(__dirname));

let korisnici = {};
if (fs.existsSync(BODOVI_FILE)) {
    try { korisnici = JSON.parse(fs.readFileSync(BODOVI_FILE, 'utf8')); } catch (e) { korisnici = {}; }
}

let pitanjaPodaci = { mix: [], cisco: [], sport: [], glazba: [], kultura: [], znanost: [], povijest: [], zemljopis: [], film: [] };
let trenutnaPitanja = {};
let tajmeri = {};
let tkoJeOdgovorio = {};

// --- AUTOMATSKO PUNJENJE PITANJA ---
const KATEGORIJE_API = { 9: 'kultura', 21: 'sport', 23: 'povijest', 22: 'zemljopis', 17: 'znanost', 11: 'film', 12: 'glazba' };

async function dopuniPitanja() {
    for (let [id, kat] of Object.entries(KATEGORIJE_API)) {
        try {
            const res = await axios.get(`https://opentdb.com/api.php?amount=20&category=${id}&type=multiple`);
            res.data.results.forEach(p => {
                pitanjaPodaci[kat].push({ pitanje: p.question, odgovor: p.correct_answer });
            });
        } catch (e) { console.log(`Greška pri povlačenju za ${kat}`); }
    }
}
dopuniPitanja();

function ucitajLokalno() {
    try {
        if (fs.existsSync(path.join(__dirname, 'pitanja', 'mix.json'))) {
            const m = JSON.parse(fs.readFileSync(path.join(__dirname, 'pitanja', 'mix.json'), 'utf8'));
            pitanjaPodaci.mix = m.pitanja || m.mix || [];
        }
        if (fs.existsSync(path.join(__dirname, 'pitanja', 'cisco.json'))) {
            const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'pitanja', 'cisco.json'), 'utf8'));
            pitanjaPodaci.cisco = c.certifikati || [];
        }
    } catch (e) { console.log("Greška pri učitavanju lokalnih datoteka."); }
}
ucitajLokalno();

io.on('connection', (socket) => {
    socket.on('prijava', (d) => {
        const ime = d.ime.trim();

        // Provjera bana
        if (korisnici[ime]?.banDo && new Date(korisnici[ime].banDo) > new Date()) {
            const istjece = new Date(korisnici[ime].banDo).toLocaleString('hr-HR');
            return socket.emit('err', `BANIRANI STE! Vaš pristup je onemogućen do: ${istjece}`);
        }

        // 1. Ako korisnik ne postoji - traži tajnu šifru
        if (!korisnici[ime]) {
            if (!d.tajnaSifra) {
                return socket.emit('otvori_tajno_polje');
            }
            if (d.tajnaSifra !== MASTER_TAJNA_SIFRA) {
                return socket.emit('err', "Pogrešna tajna šifra za registraciju!");
            }
            // Registracija
            korisnici[ime] = { lozinka: d.lozinka, tajnaSifra: d.tajnaSifra, bodovi: 0, upozorenja: 0, banDo: null };
            saveDB();
        }

        // 2. Provjera lozinke
        if (korisnici[ime].lozinka !== d.lozinka) {
            return socket.emit('err', "Pogrešna lozinka!");
        }

        socket.ime = ime;
        socket.emit('uspjesna_prijava', { ime, jeAdmin: ime === 'Blanco' });
    });

    socket.on('join_room', (soba) => {
        socket.leaveAll(); socket.join(soba); socket.soba = soba;
        if (!trenutnaPitanja[soba]) novaRunda(soba);
        else socket.emit('novo_pitanje', { pitanje: trenutnaPitanja[soba].pitanje, vrijeme: tajmeri[soba] });
    });

    socket.on('slanje_odgovora', (data) => {
        const s = socket.soba;
        const msg = data.tekst.toLowerCase().trim();

        // Provjera psovki
        if (PSOVKE.some(p => msg.includes(p))) {
            korisnici[socket.ime].upozorenja++;
            if (korisnici[socket.ime].upozorenja >= 2) {
                let sutra = new Date(); sutra.setHours(sutra.getHours() + 24);
                korisnici[socket.ime].banDo = sutra;
                saveDB();
                socket.emit('err', `Dobitnik ste BAN-a na 24h zbog vrijeđanja!`);
                return socket.disconnect();
            }
            saveDB();
            return socket.emit('rezultat', { tip: 'netocno', poruka: "⚠️ Upozorenje! Bez psovanja!" });
        }

        if (!trenutnaPitanja[s] || tkoJeOdgovorio[s]?.[socket.ime]) return;

        if (msg === trenutnaPitanja[s].odgovor.toLowerCase().trim()) {
            if (!tkoJeOdgovorio[s]) tkoJeOdgovorio[s] = {};
            let bodovi = Object.keys(tkoJeOdgovorio[s]).length === 0 ? 7 : 5;
            korisnici[socket.ime].bodovi += bodovi;
            tkoJeOdgovorio[s][socket.ime] = true;
            socket.emit('rezultat', { tip: 'tocno', poruka: `TOČNO! +${bodovi}` });
            io.to(s).emit('obavijest', `${socket.ime} je pogodio!`);
            saveDB();
        } else {
            korisnici[socket.ime].bodovi -= 2;
            socket.emit('rezultat', { tip: 'netocno', poruka: "Netočno! -2 boda" });
            saveDB();
        }
    });
});

function novaRunda(soba) {
    const lista = pitanjaPodaci[soba];
    if (!lista || lista.length === 0) return;
    trenutnaPitanja[soba] = lista[Math.floor(Math.random() * lista.length)];
    tkoJeOdgovorio[soba] = {};
    tajmeri[soba] = 30;
    io.to(soba).emit('novo_pitanje', { pitanje: trenutnaPitanja[soba].pitanje, vrijeme: 30 });

    let int = setInterval(() => {
        tajmeri[soba]--;
        if (tajmeri[soba] === 15 || tajmeri[soba] <= 10) io.to(soba).emit('tick', tajmeri[soba]);
        if (tajmeri[soba] <= 0) {
            clearInterval(int);
            io.to(soba).emit('obavijest', `Vrijeme isteklo! Odgovor: ${trenutnaPitanja[soba].odgovor}`);
            setTimeout(() => novaRunda(soba), 3000);
        }
    }, 1000);
}

function saveDB() { fs.writeFileSync(BODOVI_FILE, JSON.stringify(korisnici, null, 2)); }
server.listen(PORT, () => console.log("Arena Server Online"));