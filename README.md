# 📩 Mod-Mail Bot with Dashboard

A modern, fully customizable **Mod-Mail System** for Discord with a built-in **web dashboard**, real-time ticketing, logging, staff tools, and a clean UI.  
Perfect for servers that want a fast, reliable, and visually polished support system.

---

## 🧩 Widgets & Shields

<p align="center">
  <img src="https://img.shields.io/github/stars/UmbraXDev/Mod-Mail-Bot-With-Dashboard?style=for-the-badge" />
  <img src="https://img.shields.io/github/forks/UmbraXDev/Mod-Mail-Bot-With-Dashboard?style=for-the-badge" />
  <img src="https://img.shields.io/github/issues/UmbraXDev/Mod-Mail-Bot-With-Dashboard?style=for-the-badge" />
  <img src="https://img.shields.io/github/license/UmbraXDev/Mod-Mail-Bot-With-Dashboard?style=for-the-badge" />
</p>

---

## ✨ Features

### 🔧 Core System
- DM → Server Mod-Mail ticket creation  
- Real-time two-way syncing  
- Automatic private ticket channels  
- Staff-only access  
- Auto-close & inactivity handling  
- Anti-duplicate ticket system

### 🖥️ Dashboard
- Clean and responsive UI  
- Configure categories, staff roles, logs  
- View open & closed tickets  
- Manage settings with one click

### 📑 Logging & Transcripts
- Auto transcript generation (HTML/Text)  
- Close reasons  
- Staff action logs  
- Optional user DM logs

### ⚙️ Advanced Utilities
- Customizable emb eds/messages  
- Staff auto-ping on ticket open  
- Abuse protection  
- Smooth ticket lifecycle

---

## 🚀 Installation & Setup

### 1️⃣ **Clone the repo**
```
git clone https://github.com/UmbraXDev/Mod-Mail-Bot-With-Dashboard
cd Mod-Mail-Bot-With-Dashboard
```
2️⃣ Install dependencies
```
npm install
```
3️⃣ Create your .env file
```
DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=your_client_id_here
CLIENT_SECRET=your_client_secret_here
GUILD_ID=your_server_id_here
STAFF_ROLE_ID=your_staff_role_id_here

MONGODB_URI=mongodb://localhost:27017/modmail

CALLBACK_URL=http://localhost:3000/callback
SESSION_SECRET=change_this_to_a_long_random_string_at_least_32_characters_long
NODE_ENV=development

TRUST_PROXY=false

FRONTEND_URL=http://localhost:3000

COOKIE_SECURE=false
COOKIE_SAMESITE=lax
COOKIE_DOMAIN=
```
4️⃣ Start the bot
```
npm start
```

📬 How Mod-Mail Works

User DMs the bot

A ticket channel is created for staff

Messages sync instantly between DM ↔ staff channel

Staff can respond, tag, and manage

Ticket is closed → transcript is saved + logged

🛠️ Tech Stack
Area	Tech
Bot	Node.js, Discord.js
Dashboard	Express.js / EJS
Database	MongoDB
# 🤝 Credits
Developed by: Umbra X Development

Join the community:
➡️ https://discord.gg/Whq4T2vYPP

⭐ Support the Project

If you like this project, please star the repo — it helps a ton!
