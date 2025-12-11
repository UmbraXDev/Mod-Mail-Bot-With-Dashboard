require('dotenv').config();
const { 
  Client, 
  GatewayIntentBits, 
  Partials,
  ChannelType, 
  EmbedBuilder, 
  PermissionFlagsBits, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle,
  ActivityType 
} = require('discord.js');
const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const axios = require('axios');
const mongoose = require('mongoose');
const path = require('path');
const rateLimit = require('express-rate-limit');

mongoose.connect(process.env.MONGODB_URI, {
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
})
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => {
    console.error('❌ MongoDB connection error:', err);
    process.exit(1);
  });

mongoose.connection.on('error', err => {
  console.error('❌ MongoDB error:', err);
});

mongoose.connection.on('disconnected', () => {
  console.warn('⚠️ MongoDB disconnected');
});

const ticketSchema = new mongoose.Schema({
  user_id: { type: String, required: true, index: true },
  guild_id: { type: String, index: true },
  channel_id: { type: String, required: true },
  status: { type: String, default: 'open', enum: ['open', 'closed'], index: true },
  created_at: { type: Date, default: Date.now, index: true },
  closed_at: Date,
  closed_by: String,
  claimed_by: String,
  claimed_at: Date,
  priority: { type: String, enum: ['low', 'normal', 'high', 'urgent'], default: 'normal' },
  category: String,
  notes: [{ 
    user_id: String, 
    content: String, 
    timestamp: { type: Date, default: Date.now } 
  }]
});

const messageSchema = new mongoose.Schema({
  ticket_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Ticket', required: true, index: true },
  user_id: { type: String, required: true },
  content: String,
  attachments: [String],
  timestamp: { type: Date, default: Date.now, index: true },
  is_staff: { type: Boolean, default: false }
});

const settingSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: mongoose.Schema.Types.Mixed,
  updated_at: { type: Date, default: Date.now }
});

const guildSchema = new mongoose.Schema({
  guild_id: { type: String, required: true, unique: true, index: true },
  name: String,
  modmail_category_id: String,
  staff_role_id: String,
  log_channel_id: String,
  is_default: { type: Boolean, default: false },
  created_at: { type: Date, default: Date.now }
});

const blockedUserSchema = new mongoose.Schema({
  user_id: { type: String, required: true, unique: true },
  blocked_at: { type: Date, default: Date.now },
  blocked_by: String,
  reason: String
});

ticketSchema.index({ user_id: 1, status: 1 });
messageSchema.index({ ticket_id: 1, timestamp: 1 });

const Ticket = mongoose.model('Ticket', ticketSchema);
const Message = mongoose.model('Message', messageSchema);
const Setting = mongoose.model('Setting', settingSchema);
const GuildSetting = mongoose.model('GuildSetting', guildSchema);
const BlockedUser = mongoose.model('BlockedUser', blockedUserSchema);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers
  ],
  partials: [
    Partials.Channel,
    Partials.Message
  ]
});

const app = express();

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests from this IP, please try again later.'
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many login attempts, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req, res) => {
    return req.session && req.session.user;
  }
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));

app.use(express.static(path.join(__dirname, '../public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

if (process.env.TRUST_PROXY === 'true' || process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

const FRONTEND_URL = process.env.FRONTEND_URL || null;
app.use((req, res, next) => {
  if (FRONTEND_URL) {
    res.header('Access-Control-Allow-Origin', FRONTEND_URL);
    res.header('Access-Control-Allow-Credentials', 'true');
  } else {
    res.header('Access-Control-Allow-Origin', '*');
  }
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const cookieSecure = process.env.COOKIE_SECURE === 'true';
const cookieSameSite = process.env.COOKIE_SAMESITE || 'Lax';
const cookieDomain = process.env.COOKIE_DOMAIN || undefined;

app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key-change-this',
  resave: true,
  saveUninitialized: true,
  name: 'modmail.sid',
  store: MongoStore.create({
    mongoUrl: process.env.MONGODB_URI,
    ttl: 30 * 24 * 60 * 60,
    touchAfter: 12 * 3600,
    autoRemove: 'interval',
    autoRemoveInterval: 60
  }),
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    secure: cookieSecure,
    sameSite: cookieSameSite,
    domain: cookieDomain,
    path: '/'
  }
}));

app.use('/api/', apiLimiter);
app.use('/login', loginLimiter);
app.use('/callback', loginLimiter);

function isAuthenticated(req, res, next) {
  if (req.session.user) {
    return next();
  }
  res.redirect('/login');
}

async function isStaff(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/login');
  }
  
  try {
    const guild = client.guilds.cache.get(process.env.GUILD_ID);
    if (!guild) {
      return res.status(500).send('Guild not found');
    }

    const member = await guild.members.fetch(req.session.user.id).catch(() => null);
    
    if (!member) {
      return res.status(403).send('You are not a member of the server');
    }
    
    if (member.roles.cache.has(process.env.STAFF_ROLE_ID) || 
        member.permissions.has(PermissionFlagsBits.Administrator)) {
      req.userRole = 'staff';
      return next();
    }
    
    res.status(403).send('Access denied. Staff role required.');
  } catch (error) {
    console.error('Error checking staff status:', error);
    res.status(500).send('Error verifying permissions');
  }
}

async function isStaffInGuild(guildId, userId) {
  try {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return false;
    
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return false;
    
    const guildSetting = await GuildSetting.findOne({ guild_id: guildId });
    const staffRoleId = guildSetting?.staff_role_id || process.env.STAFF_ROLE_ID;
    
    return member.roles.cache.has(staffRoleId) || 
           member.permissions.has(PermissionFlagsBits.Administrator);
  } catch (error) {
    console.error('Error checking guild staff status:', error);
    return false;
  }
}

function userDashboard(req, res, next) {
  if (req.session.user) {
    req.userRole = 'user';
    return next();
  }
  res.redirect('/login');
}

app.get('/', (req, res) => {
  res.render('index', { user: req.session.user });
});

app.get('/login', (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.CLIENT_ID,
    redirect_uri: process.env.CALLBACK_URL,
    response_type: 'code',
    scope: 'identify guilds'
  });
  const authUrl = `https://discord.com/api/oauth2/authorize?${params.toString()}`;
  res.redirect(authUrl);
});

app.get('/callback', async (req, res) => {
  const code = req.query.code;
  
  try {
    const tokenResponse = await axios.post('https://discord.com/api/oauth2/token',
      new URLSearchParams({
        client_id: process.env.CLIENT_ID,
        client_secret: process.env.CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: process.env.CALLBACK_URL
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    const { access_token } = tokenResponse.data;

    const userResponse = await axios.get('https://discord.com/api/users/@me', {
      headers: {
        Authorization: `Bearer ${access_token}`
      }
    });

    req.session.user = userResponse.data;
    res.redirect('/dashboard');
  } catch (error) {
    console.error('OAuth error:', error.response?.data || error.message);
    res.redirect('/?error=auth_failed');
  }
});

app.get('/dashboard', isAuthenticated, async (req, res) => {
  try {
    const userGuilds = { staff: [], admin: [] };
    
    try {
      const configured = await GuildSetting.find().lean().catch(() => []);
      for (const cfg of configured) {
        try {
          const guild = client.guilds.cache.get(cfg.guild_id);
          if (guild) {
            const member = await guild.members.fetch(req.session.user.id).catch(() => null);
            if (!member) continue;
            
            if (member.permissions.has(PermissionFlagsBits.Administrator)) {
              userGuilds.admin.push(cfg.guild_id);
            } else if (cfg.staff_role_id && member.roles.cache.has(cfg.staff_role_id)) {
              userGuilds.staff.push(cfg.guild_id);
            }
          }
        } catch (e) {
        }
      }
    } catch (e) {
      console.error('Error determining staff/admin guilds:', e);
    }
    
    const allUserGuilds = [...userGuilds.admin, ...userGuilds.staff];
    const isUserStaff = allUserGuilds.length > 0;
    const isUserAdmin = userGuilds.admin.length > 0;
    
    let openTickets, closedTickets, stats;
    
    if (!isUserStaff) {
      openTickets = await Ticket.find({ user_id: req.session.user.id, status: 'open' })
        .sort({ created_at: -1 })
        .limit(10)
        .lean();
      
      closedTickets = await Ticket.find({ user_id: req.session.user.id, status: 'closed' })
        .sort({ closed_at: -1 })
        .limit(10)
        .lean();
      
      stats = {
        total: await Ticket.countDocuments({ user_id: req.session.user.id }),
        open: openTickets.length,
        closed: await Ticket.countDocuments({ user_id: req.session.user.id, status: 'closed' }),
        today: await Ticket.countDocuments({ 
          user_id: req.session.user.id,
          created_at: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) } 
        }),
        claimed: 0
      };
    } else {
      openTickets = await Ticket.find({ guild_id: { $in: allUserGuilds }, status: 'open' })
        .sort({ created_at: -1 })
        .limit(20)
        .lean();
      
      closedTickets = await Ticket.find({ guild_id: { $in: allUserGuilds }, status: 'closed' })
        .sort({ closed_at: -1 })
        .limit(50)
        .lean();
      
      stats = {
        total: await Ticket.countDocuments({ guild_id: { $in: allUserGuilds } }),
        open: await Ticket.countDocuments({ guild_id: { $in: allUserGuilds }, status: 'open' }),
        closed: await Ticket.countDocuments({ guild_id: { $in: allUserGuilds }, status: 'closed' }),
        today: await Ticket.countDocuments({ 
          guild_id: { $in: allUserGuilds },
          created_at: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) } 
        }),
        claimed: await Ticket.countDocuments({ guild_id: { $in: allUserGuilds }, claimed_by: { $exists: true }, status: 'open' })
      };
    }

    for (let ticket of openTickets) {
      try {
        const user = await client.users.fetch(ticket.user_id);
        ticket.user = {
          tag: user.tag,
          avatar: user.displayAvatarURL()
        };
      } catch (err) {
        ticket.user = {
          tag: 'Unknown User',
          avatar: null
        };
      }
    }

    for (let ticket of closedTickets) {
      try {
        const user = await client.users.fetch(ticket.user_id);
        ticket.user = {
          tag: user.tag,
          avatar: user.displayAvatarURL()
        };
      } catch (err) {
        ticket.user = {
          tag: 'Unknown User',
          avatar: null
        };
      }
    }

    res.render('dashboard', { 
      user: req.session.user, 
      openTickets,
      closedTickets,
      stats,
      showAll: req.query.view === 'all',
      isStaff: isUserStaff,
      isAdmin: isUserAdmin,
      userRole: isUserAdmin ? 'admin' : (isUserStaff ? 'staff' : 'user'),
      userAdminGuilds: userGuilds.admin,
      userStaffGuilds: userGuilds.staff
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).send('Error loading dashboard');
  }
});

app.get('/ticket/:id', isAuthenticated, async (req, res) => {
  try {
    const ticket = await Ticket.findById(req.params.id).lean();
    
    if (!ticket) {
      return res.status(404).send('Ticket not found');
    }

    const guildForTicket = ticket.guild_id || process.env.GUILD_ID;
    const isUserStaff = await isStaffInGuild(guildForTicket, req.session.user.id);
    if (!isUserStaff && ticket.user_id !== req.session.user.id) {
      return res.status(403).send('You do not have permission to view this ticket');
    }

    const messages = await Message.find({ ticket_id: ticket._id })
      .sort({ timestamp: 1 })
      .lean();
    
    for (let msg of messages) {
      try {
        const user = await client.users.fetch(msg.user_id);
        msg.user = {
          tag: user.tag,
          avatar: user.displayAvatarURL()
        };
      } catch (err) {
        msg.user = {
          tag: 'Unknown User',
          avatar: null
        };
      }
    }

    try {
      const ticketUser = await client.users.fetch(ticket.user_id);
      ticket.user = {
        tag: ticketUser.tag,
        avatar: ticketUser.displayAvatarURL()
      };
    } catch (err) {
      ticket.user = {
        tag: 'Unknown User',
        avatar: null
      };
    }

    res.render('ticket', { 
      user: req.session.user, 
      ticket,
      messages,
      isStaff: isUserStaff
    });
  } catch (error) {
    console.error('Ticket view error:', error);
    res.status(500).send('Error loading ticket');
  }
});

app.post('/api/ticket/:id/close', isAuthenticated, isStaff, async (req, res) => {
  try {
    const ticket = await Ticket.findById(req.params.id);
    
    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    if (ticket.status === 'closed') {
      return res.status(400).json({ error: 'Ticket already closed' });
    }

    const channel = await client.channels.fetch(ticket.channel_id).catch(() => null);
    
    if (channel) {
      await channel.delete('Ticket closed via dashboard');
    }
    
    ticket.status = 'closed';
    ticket.closed_at = new Date();
    ticket.closed_by = req.session.user.id;
    await ticket.save();
    
    try {
      const user = await client.users.fetch(ticket.user_id);
      const embed = new EmbedBuilder()
        .setColor(0xe74c3c)
        .setTitle('🔒 Ticket Closed')
        .setDescription('Your ModMail ticket has been closed by staff.')
        .setTimestamp();
      await user.send({ embeds: [embed] });
    } catch (err) {
      console.error('Could not notify user:', err);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error closing ticket:', error);
    res.status(500).json({ error: 'Failed to close ticket' });
  }
});

app.post('/api/ticket/:id/delete', isAuthenticated, isStaff, async (req, res) => {
  try {
    const ticket = await Ticket.findById(req.params.id);
    
    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    const channel = await client.channels.fetch(ticket.channel_id).catch(() => null);
    
    if (channel) {
      await channel.delete('Ticket deleted via dashboard');
    }

    await Message.deleteMany({ ticket_id: ticket._id });
    
    await Ticket.findByIdAndDelete(req.params.id);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting ticket:', error);
    res.status(500).json({ error: 'Failed to delete ticket' });
  }
});

app.post('/api/ticket/:id/claim', isAuthenticated, isStaff, async (req, res) => {
  try {
    const ticket = await Ticket.findById(req.params.id);
    
    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    ticket.claimed_by = req.session.user.id;
    ticket.claimed_at = new Date();
    await ticket.save();
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error claiming ticket:', error);
    res.status(500).json({ error: 'Failed to claim ticket' });
  }
});

app.post('/api/ticket/:id/note', isAuthenticated, isStaff, async (req, res) => {
  try {
    const { content } = req.body;
    
    if (!content || content.trim().length === 0) {
      return res.status(400).json({ error: 'Note content required' });
    }

    const ticket = await Ticket.findById(req.params.id);
    
    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    ticket.notes.push({
      user_id: req.session.user.id,
      content: content,
      timestamp: new Date()
    });
    
    await ticket.save();
    res.json({ success: true });
  } catch (error) {
    console.error('Error adding note:', error);
    res.status(500).json({ error: 'Failed to add note' });
  }
});

async function isAdmin(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const mainGuild = client.guilds.cache.get(process.env.GUILD_ID);
    if (mainGuild) {
      const member = await mainGuild.members.fetch(req.session.user.id).catch(() => null);
      if (member && member.permissions.has(PermissionFlagsBits.Administrator)) {
        return next();
      }
    }

    const guilds = await GuildSetting.find().lean();
    for (const cfg of guilds) {
      const guild = client.guilds.cache.get(cfg.guild_id);
      if (guild) {
        const member = await guild.members.fetch(req.session.user.id).catch(() => null);
        if (member && member.permissions.has(PermissionFlagsBits.Administrator)) {
          return next();
        }
      }
    }

    return res.status(403).json({ error: 'Admin access required in at least one configured guild' });
  } catch (error) {
    console.error('Error checking admin status:', error);
    return res.status(500).json({ error: 'Failed to verify admin permissions' });
  }
}

app.get('/api/servers', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const allServers = await GuildSetting.find().sort({ created_at: -1 }).lean();
    
    const userAdminServers = [];
    for (const server of allServers) {
      try {
        const guild = client.guilds.cache.get(server.guild_id);
        if (guild) {
          const member = await guild.members.fetch(req.session.user.id).catch(() => null);
          if (member && member.permissions.has(PermissionFlagsBits.Administrator)) {
            userAdminServers.push(server);
          }
        }
      } catch (e) {
      }
    }
    
    res.json({ success: true, servers: userAdminServers });
  } catch (error) {
    console.error('Error fetching servers:', error);
    res.status(500).json({ error: 'Failed to fetch servers' });
  }
});

app.post('/api/servers', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const { guild_id, name, modmail_category_id, staff_role_id, log_channel_id, is_default } = req.body;
    if (!guild_id) return res.status(400).json({ error: 'guild_id required' });

    let guild = null;
    try {
      guild = await client.guilds.fetch(guild_id);
    } catch (err) {
      return res.status(400).json({ error: 'Bot is not a member of the specified guild or guild not found' });
    }

    try {
      const member = await guild.members.fetch(req.session.user.id).catch(() => null);
      if (!member || !member.permissions.has(PermissionFlagsBits.Administrator)) {
        return res.status(403).json({ error: 'You must be an administrator in the target guild to register it' });
      }
    } catch (e) {
      return res.status(500).json({ error: 'Failed to verify user permissions in the guild' });
    }

    if (staff_role_id) {
      const role = guild.roles.cache.get(staff_role_id) || await guild.roles.fetch(staff_role_id).catch(() => null);
      if (!role) return res.status(400).json({ error: 'staff_role_id not found in guild' });
    }

    if (modmail_category_id) {
      const channel = guild.channels.cache.get(modmail_category_id) || await guild.channels.fetch(modmail_category_id).catch(() => null);
      if (!channel || channel.type !== ChannelType.GuildCategory) return res.status(400).json({ error: 'modmail_category_id is not a category channel in the guild' });
    }

    if (is_default) {
      await GuildSetting.updateMany({}, { $set: { is_default: false } });
    }

    const existing = await GuildSetting.findOne({ guild_id });
    if (existing) return res.status(400).json({ error: 'Server already exists' });

    const server = new GuildSetting({ guild_id, name, modmail_category_id, staff_role_id, log_channel_id, is_default: !!is_default });
    await server.save();
    res.json({ success: true, server });
  } catch (error) {
    console.error('Error creating server:', error);
    res.status(500).json({ error: 'Failed to create server' });
  }
});

app.put('/api/servers/:id', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const { name, modmail_category_id, staff_role_id, log_channel_id, is_default } = req.body;
    const serverDoc = await GuildSetting.findById(id);
    if (!serverDoc) return res.status(404).json({ error: 'Server not found' });

    const guildId = serverDoc.guild_id;
    let guild = null;
    try {
      guild = await client.guilds.fetch(guildId);
    } catch (err) {
      return res.status(400).json({ error: 'Configured guild for this server is not available to the bot' });
    }

    try {
      const member = await guild.members.fetch(req.session.user.id).catch(() => null);
      if (!member || !member.permissions.has(PermissionFlagsBits.Administrator)) {
        return res.status(403).json({ error: 'You must be an administrator in the target guild to update its configuration' });
      }
    } catch (e) {
      return res.status(500).json({ error: 'Failed to verify user permissions in the guild' });
    }

    if (staff_role_id) {
      const role = guild.roles.cache.get(staff_role_id) || await guild.roles.fetch(staff_role_id).catch(() => null);
      if (!role) return res.status(400).json({ error: 'staff_role_id not found in guild' });
    }

    if (modmail_category_id) {
      const channel = guild.channels.cache.get(modmail_category_id) || await guild.channels.fetch(modmail_category_id).catch(() => null);
      if (!channel || channel.type !== ChannelType.GuildCategory) return res.status(400).json({ error: 'modmail_category_id is not a category channel in the guild' });
    }

    if (is_default) {
      await GuildSetting.updateMany({}, { $set: { is_default: false } });
    }

    serverDoc.name = name;
    serverDoc.modmail_category_id = modmail_category_id;
    serverDoc.staff_role_id = staff_role_id;
    serverDoc.log_channel_id = log_channel_id;
    serverDoc.is_default = !!is_default;
    await serverDoc.save();
    res.json({ success: true, server: serverDoc });
  } catch (error) {
    console.error('Error updating server:', error);
    res.status(500).json({ error: 'Failed to update server' });
  }
});

app.delete('/api/servers/:id', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const server = await GuildSetting.findByIdAndDelete(id);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting server:', error);
    res.status(500).json({ error: 'Failed to delete server' });
  }
});

app.get('/api/stats', isAuthenticated, isStaff, async (req, res) => {
  try {
    const now = new Date();
    const today = new Date(now.setHours(0, 0, 0, 0));
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const stats = {
      total: await Ticket.countDocuments(),
      open: await Ticket.countDocuments({ status: 'open' }),
      closed: await Ticket.countDocuments({ status: 'closed' }),
      today: await Ticket.countDocuments({ created_at: { $gte: today } }),
      thisWeek: await Ticket.countDocuments({ created_at: { $gte: weekAgo } }),
      blocked: await BlockedUser.countDocuments()
    };

    res.json(stats);
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

app.get('/api/bot-guilds', isAuthenticated, async (req, res) => {
  try {
    const guilds = [];
    for (const [id, guild] of client.guilds.cache) {
      let isMember = false;
      let isAdmin = false;
      let isStaff = false;
      
      try {
        const member = await guild.members.fetch(req.session.user.id).catch(() => null);
        if (member) {
          isMember = true;
          isAdmin = member.permissions.has(PermissionFlagsBits.Administrator) || member.permissions.has(PermissionFlagsBits.ManageGuild);
          
          const cfg = await GuildSetting.findOne({ guild_id: id }).lean().catch(() => null);
          const staffRole = cfg ? cfg.staff_role_id : null;
          if (staffRole && member.roles.cache.has(staffRole)) {
            isStaff = true;
          }
        }
      } catch (e) {
      }

      if (!isStaff && !isAdmin) continue;

      const cfg = await GuildSetting.findOne({ guild_id: id }).lean().catch(() => null);

      guilds.push({
        guild_id: id,
        name: guild.name,
        iconURL: guild.iconURL(),
        memberCount: guild.memberCount,
        isConfigured: !!cfg,
        staff_role_id: cfg ? cfg.staff_role_id : null,
        isMember,
        isAdmin
      });
    }

    res.json({ success: true, guilds });
  } catch (error) {
    console.error('Error fetching bot guilds:', error);
    res.status(500).json({ error: 'Failed to fetch guilds' });
  }
});

app.get('/api/tickets', isAuthenticated, async (req, res) => {
  try {
    const guildId = req.query.guild_id;
    if (!guildId) return res.status(400).json({ error: 'guild_id required' });

    let guild = null;
    try {
      guild = await client.guilds.fetch(guildId);
    } catch (err) {
      return res.status(400).json({ error: 'Guild not available to bot' });
    }

    let member = null;
    try {
      member = await guild.members.fetch(req.session.user.id).catch(() => null);
    } catch (e) {
    }

    const cfg = await GuildSetting.findOne({ guild_id: guildId }).lean().catch(() => null);
    const staffRole = cfg ? cfg.staff_role_id : null;

    const userIsAllowed = !!(member && (member.permissions.has(PermissionFlagsBits.Administrator) || (staffRole && member.roles.cache.has(staffRole))));

    if (!userIsAllowed) return res.status(403).json({ error: 'You do not have permission to view tickets for this guild' });

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 10));
    const skip = (page - 1) * limit;

    const [tickets, total] = await Promise.all([
      Ticket.find({ guild_id: guildId }).sort({ created_at: -1 }).skip(skip).limit(limit).lean(),
      Ticket.countDocuments({ guild_id: guildId })
    ]);

    for (let ticket of tickets) {
      try {
        const user = await client.users.fetch(ticket.user_id).catch(() => null);
        ticket.user = user ? { tag: user.tag, avatar: user.displayAvatarURL() } : { tag: 'Unknown User', avatar: null };
      } catch (err) {
        ticket.user = { tag: 'Unknown User', avatar: null };
      }
    }

    res.json({ success: true, tickets, total, page, limit });
  } catch (error) {
    console.error('Error fetching tickets for guild:', error);
    res.status(500).json({ error: 'Failed to fetch tickets' });
  }
});

app.get('/api/ping', isAuthenticated, async (req, res) => {
  try {
    const ping = client.ws?.ping || null;
    const uptime = process.uptime();
    const guildCount = client.guilds.cache.size;
    res.json({ success: true, ping, uptime, guildCount });
  } catch (error) {
    console.error('Error fetching ping:', error);
    res.status(500).json({ error: 'Failed to fetch ping' });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Error destroying session:', err);
      return res.status(500).send('Error logging out');
    }
    res.redirect('/');
  });
});

client.on('ready', () => {
  console.log(`✅ Bot logged in as ${client.user.tag}`);
  console.log(`🌐 Dashboard running on ${process.env.DASHBOARD_URL || 'http://localhost:3000'}`);
  console.log(`📊 Guilds: ${client.guilds.cache.size}`);
  console.log(`👥 Users: ${client.users.cache.size}`);
  
  client.user.setActivity('DMs for Support', { type: ActivityType.Watching });
  
  const guild = client.guilds.cache.get(process.env.GUILD_ID);
  if (guild) {
    console.log(`✅ Connected to guild: ${guild.name}`);
  } else {
    console.error('❌ Could not find guild with ID:', process.env.GUILD_ID);
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  try {
    if (message.channel.type === ChannelType.DM) {
      console.log(`📨 DM received from ${message.author.tag} (${message.author.id})`);
      console.log(`📝 Content: ${message.content.substring(0, 100)}`);
      await handleDM(message);
      return;
    }

    if (message.guild && message.channel.name && message.channel.name.startsWith('modmail-')) {
      console.log(`💬 Staff message in ${message.channel.name}`);
      await handleModMailChannel(message);
    }
  } catch (error) {
    console.error('❌ Error in messageCreate:', error);
    
    try {
      if (message.channel.type === ChannelType.DM) {
        await message.reply('❌ An error occurred. Please try again or contact an administrator.');
      }
    } catch (e) {
      console.error('Failed to send error message:', e);
    }
  }
});

async function handleDM(message) {
  try {
    console.log(`🔍 Processing DM from ${message.author.tag}`);

    const blocked = await BlockedUser.findOne({ user_id: message.author.id });
    if (blocked) {
      console.log(`🚫 User ${message.author.tag} is blocked`);
      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xff0000)
            .setTitle('❌ Access Denied')
            .setDescription('You are blocked from using ModMail.')
            .addFields({ name: 'Reason', value: blocked.reason || 'No reason provided' })
        ]
      });
    }

    console.log(`🔐 Validating user ${message.author.tag} has access to available servers`);
    const userGuilds = await client.guilds.fetch().then(guilds => 
      guilds.map(g => g.id)
    ).catch(err => {
      console.error('Failed to fetch bot guilds:', err);
      return [];
    });
    
    if (userGuilds.length === 0) {
      console.warn('⚠️ Bot is not in any guilds');
      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xff0000)
            .setTitle('❌ Configuration Error')
            .setDescription('ModMail is not properly configured. Please contact an administrator.')
        ]
      });
    }

    let availableGuilds = await GuildSetting.find().lean().catch(() => []);
    
    console.log(`📊 Available configured guilds: ${availableGuilds.length}`);
    availableGuilds = availableGuilds.filter(guild => {
      const isCommon = userGuilds.includes(guild.guild_id);
      if (!isCommon) {
        console.log(`🚫 Filtering out guild ${guild.guild_id} - user not a member`);
      }
      return isCommon;
    });
    console.log(`✅ Guilds user can contact: ${availableGuilds.length}`);
    
    let guildConfigForDM = null;
    
    if (availableGuilds.length === 0) {
      console.warn(`❌ User ${message.author.tag} has no access to any configured servers`);
      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xff0000)
            .setTitle('❌ Access Denied')
            .setDescription('You are not a member of any servers with ModMail enabled. Please join a server and try again.')
        ]
      });
    }
    
    if (availableGuilds.length > 1) {
      console.log(`📋 User has multiple server options (${availableGuilds.length})`);
      
      const existingTicket = await Ticket.findOne({ user_id: message.author.id, status: 'open' });
      if (existingTicket) {
        console.log(`📬 Reusing existing ticket for guild: ${existingTicket.guild_id}`);
        guildConfigForDM = availableGuilds.find(g => g.guild_id === existingTicket.guild_id);
      } else {
        console.log('🎯 Showing server selection menu to user');
        const buttons = availableGuilds.map((g, idx) => 
          new ButtonBuilder()
            .setCustomId(`guild_select_${g.guild_id}`)
            .setLabel(g.name || `Server ${idx + 1}`)
            .setStyle(ButtonStyle.Primary)
        );

        const actionRow = new ActionRowBuilder().addComponents(buttons.slice(0, 5));
        const selectionMsg = await message.reply({
          content: '👋 Hello! You can contact multiple servers. Which server would you like to reach?\n\n*Select a server from the buttons below:*\n\n⏰ *You have 60 seconds to choose.*',
          components: [actionRow]
        });

        const collector = selectionMsg.createMessageComponentCollector({ time: 60000 });
        let selectedGuild = null;
        let selectionComplete = false;

        collector.on('collect', async (interaction) => {
          if (interaction.user.id !== message.author.id) {
            return interaction.reply({ content: '❌ You can only interact with your own messages.', ephemeral: true });
          }

          const guildId = interaction.customId.replace('guild_select_', '');
          selectedGuild = availableGuilds.find(g => g.guild_id === guildId);

          if (selectedGuild) {
            guildConfigForDM = selectedGuild;
            selectionComplete = true;
            await interaction.reply({ content: `✅ You've selected **${selectedGuild.name || guildId}**. Your message will be sent there.`, ephemeral: true });
            collector.stop();
          }
        });

        collector.on('end', async () => {
          if (!selectedGuild) {
            console.log(`⏱️ Selection timeout - user did not choose a server. Ignoring DM.`);
            try {
              await message.reply({
                embeds: [
                  new EmbedBuilder()
                    .setColor(0xffaa00)
                    .setTitle('⏰ Selection Timeout')
                    .setDescription('You took too long to select a server. Your message was not sent.\n\nPlease send another message and select a server within 60 seconds.')
                ]
              });
            } catch (e) {
              console.error('Failed to send timeout notification:', e);
            }
          }
        });

        await new Promise(resolve => {
          collector.on('end', resolve);
        });

        if (!selectedGuild) {
          console.log(`🛑 Stopping DM processing - no server selected within timeout`);
          return;
        }
      }
    } else if (availableGuilds.length === 1) {
      guildConfigForDM = availableGuilds[0];
      console.log(`✅ Single guild: ${guildConfigForDM.name || guildConfigForDM.guild_id}`);
    } else {
      if (process.env.GUILD_ID) {
        console.warn('⚠️ No guilds in DB, using env GUILD_ID');
      }
    }

    if (!guildConfigForDM) {
      console.error('❌ No guild config available - cannot create ticket');
      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xff0000)
            .setTitle('❌ Configuration Error')
            .setDescription('No servers are configured. Please contact an administrator.')
        ]
      });
    }

    const ticketQuery = { user_id: message.author.id, status: 'open' };
    if (guildConfigForDM && guildConfigForDM.guild_id) ticketQuery.guild_id = guildConfigForDM.guild_id;
    let ticket = await Ticket.findOne(ticketQuery);
    
    if (!ticket) {
      console.log(`🆕 Creating new ticket for ${message.author.tag}`);
      
      ticket = await createTicket(message.author, guildConfigForDM);
      
      if (!ticket) {
        console.error('❌ Failed to create ticket');
        return message.reply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xff0000)
              .setTitle('❌ Error')
              .setDescription('Failed to create your ticket. Please try again later or contact an administrator.')
          ]
        });
      }

      const embed = new EmbedBuilder()
        .setColor(0x00ff00)
        .setTitle('✅ ModMail Ticket Created')
        .setDescription('Your message has been sent to our staff team. We\'ll respond as soon as possible!')
        .addFields(
          { name: '💬 Response Time', value: 'Usually within a few hours', inline: true },
          { name: '📝 Ticket ID', value: `\`${ticket._id}\``, inline: true }
        )
        .setFooter({ text: 'Reply here to continue the conversation' })
        .setTimestamp();

      await message.reply({ embeds: [embed] });
    } else {
      console.log(`📬 Existing ticket found: ${ticket._id}`);
    }

    const channel = await client.channels.fetch(ticket.channel_id).catch(async (err) => {
      console.error(`❌ Channel ${ticket.channel_id} not found:`, err.message);
      
      console.log('🔄 Creating new channel for existing ticket...');
      const newTicket = await createTicket(message.author);
      
      if (newTicket) {
        ticket.channel_id = newTicket.channel_id;
        await ticket.save();
        return await client.channels.fetch(newTicket.channel_id);
      }
      
      return null;
    });
    
    if (!channel) {
      console.error('❌ Could not access or create channel');
      return message.reply('❌ An error occurred. Please try again.');
    }

    const embed = new EmbedBuilder()
      .setColor(0x3498db)
      .setAuthor({ 
        name: `${message.author.tag} (${message.author.id})`,
        iconURL: message.author.displayAvatarURL() 
      })
      .setDescription(message.content || '*[No text content]*')
      .setFooter({ text: `User ID: ${message.author.id} | Ticket: ${ticket._id}` })
      .setTimestamp();

    const attachmentUrls = [];
    if (message.attachments.size > 0) {
      message.attachments.forEach(attachment => {
        attachmentUrls.push(attachment.url);
        embed.addFields({ name: '📎 Attachment', value: `[${attachment.name}](${attachment.url})` });
      });
      
      const firstImage = message.attachments.find(att => 
        att.contentType?.startsWith('image/')
      );
      if (firstImage) {
        embed.setImage(firstImage.url);
      }
    }

    await channel.send({ embeds: [embed] });
    console.log(`✅ Message forwarded to channel ${channel.name}`);

    const newMessage = new Message({
      ticket_id: ticket._id,
      user_id: message.author.id,
      content: message.content,
      attachments: attachmentUrls,
      timestamp: new Date(),
      is_staff: false
    });
    await newMessage.save();
    console.log(`💾 Message saved to database`);

    await message.react('✅').catch(() => {});

  } catch (error) {
    console.error('❌ Error in handleDM:', error);
    throw error;
  }
}

async function handleModMailChannel(message) {
  if (message.author.bot) return;

  const userId = message.channel.topic;
  if (!userId) {
    console.warn('⚠️ ModMail channel has no topic (user ID)');
    return;
  }

  try {
    const ticket = await Ticket.findOne({ channel_id: message.channel.id, status: 'open' });
    
    if (!ticket) {
      console.warn(`⚠️ No open ticket found for channel ${message.channel.id}`);
      return message.reply('⚠️ No open ticket found for this channel.');
    }

    const user = await client.users.fetch(userId).catch(() => null);
    
    if (!user) {
      return message.reply('❌ Could not find user.');
    }

    const embed = new EmbedBuilder()
      .setColor(0x9b59b6)
      .setAuthor({ 
        name: `${message.author.tag} (Staff)`,
        iconURL: message.author.displayAvatarURL() 
      })
      .setDescription(message.content || '*[No text content]*')
      .setFooter({ text: 'Staff Response' })
      .setTimestamp();

    const attachmentUrls = [];
    if (message.attachments.size > 0) {
      message.attachments.forEach(attachment => {
        attachmentUrls.push(attachment.url);
        embed.addFields({ name: '📎 Attachment', value: `[${attachment.name}](${attachment.url})` });
      });
      
      const firstImage = message.attachments.find(att => 
        att.contentType?.startsWith('image/')
      );
      if (firstImage) {
        embed.setImage(firstImage.url);
      }
    }

    await user.send({ embeds: [embed] });
    await message.react('✅');
    console.log(`✅ Staff message sent to user ${user.tag}`);

    const newMessage = new Message({
      ticket_id: ticket._id,
      user_id: message.author.id,
      content: message.content,
      attachments: attachmentUrls,
      timestamp: new Date(),
      is_staff: true
    });
    await newMessage.save();

  } catch (error) {
    console.error('❌ Error in handleModMailChannel:', error);
    await message.reply('❌ Failed to send message to user.').catch(() => {});
  }
}

async function createTicket(user, guildConfig = null) {
  try {
    console.log(`🎫 Creating ticket for ${user.tag} (${user.id})`);
    
    let guild = null;
    if (!guildConfig) {
      guildConfig = await GuildSetting.findOne({ is_default: true }).lean().catch(() => null);
      if (!guildConfig) {
        guildConfig = await GuildSetting.findOne().lean().catch(() => null);
      }
    }

    if (guildConfig && guildConfig.guild_id) {
      guild = client.guilds.cache.get(guildConfig.guild_id);
      if (!guild) {
        console.warn('⚠️ Configured guild not found in client cache:', guildConfig.guild_id);
      }
    }

    if (!guild) {
      if (process.env.GUILD_ID) {
        guild = client.guilds.cache.get(process.env.GUILD_ID);
      }
    }

    if (!guild) {
      console.error('❌ No guild available to create channels in (check settings or environment variables)');
      throw new Error('Guild not found');
    }

    console.log(`✅ Guild found: ${guild.name}`);

    let category = null;
    const categoryId = guildConfig?.modmail_category_id || process.env.MODMAIL_CATEGORY_ID;
    if (categoryId) {
      category = guild.channels.cache.get(categoryId);
      if (category) {
        console.log(`✅ Category found: ${category.name}`);
      } else {
        console.warn('⚠️ Category not found, creating channel without category');
      }
    }

    const timestamp = Date.now();
    const username = user.username.toLowerCase().replace(/[^a-z0-9]/g, '');
    const channelName = `modmail-${username}-${timestamp}`;

    console.log(`📝 Creating channel: ${channelName}`);

    const staffRoleId = guildConfig?.staff_role_id || process.env.STAFF_ROLE_ID;
    let staffRole = staffRoleId ? guild.roles.cache.get(staffRoleId) : null;
    
    if (!staffRole && staffRoleId) {
      try {
        staffRole = await guild.roles.fetch(staffRoleId).catch(() => null);
      } catch (e) {
        console.warn('⚠️ Could not fetch staff role:', staffRoleId);
      }
    }
    
    if (!staffRole) {
      console.error('❌ Staff role not found:', staffRoleId);
    } else {
      console.log(`✅ Staff role found: ${staffRole.name}`);
    }

    const permissionOverwrites = [
      {
        id: guild.id,
        deny: [PermissionFlagsBits.ViewChannel]
      },
      {
        id: client.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ManageChannels
        ]
      }
    ];

    if (staffRole) {
      permissionOverwrites.push({
        id: staffRole.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks
        ]
      });
    }

    const channel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: category?.id,
      topic: user.id,
      reason: `ModMail ticket for ${user.tag}`,
      permissionOverwrites
    });

    console.log(`✅ Channel created: ${channel.name} (${channel.id})`);

    const embed = new EmbedBuilder()
      .setColor(0x00ff00)
      .setTitle('📬 New ModMail Ticket')
      .setDescription(`A new support ticket has been created.`)
      .addFields(
        { name: '👤 User', value: `${user.tag}\n${user}`, inline: true },
        { name: '🆔 User ID', value: user.id, inline: true },
        { name: '📅 Created', value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: true },
        { name: '📊 Account Age', value: `<t:${Math.floor(user.createdTimestamp / 1000)}:R>`, inline: true }
      )
      .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 256 }))
      .setFooter({ text: 'Reply in this channel to respond to the user' })
      .setTimestamp();

    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('close_ticket')
          .setLabel('Close Ticket')
          .setStyle(ButtonStyle.Danger)
          .setEmoji('🔒'),
        new ButtonBuilder()
          .setCustomId('claim_ticket')
          .setLabel('Claim')
          .setStyle(ButtonStyle.Primary)
          .setEmoji('✋')
      );

    await channel.send({ 
      content: staffRole ? `${staffRole}` : '@here',
      embeds: [embed], 
      components: [row] 
    });

    const ticket = new Ticket({
      user_id: user.id,
      guild_id: guild.id,
      channel_id: channel.id,
      status: 'open',
      created_at: new Date()
    });
    await ticket.save();
    console.log(`💾 Ticket saved to database: ${ticket._id}`);

    if (process.env.LOG_CHANNEL_ID) {
      const logChannel = guild.channels.cache.get(process.env.LOG_CHANNEL_ID);
      if (logChannel) {
        const logEmbed = new EmbedBuilder()
          .setColor(0x00ff00)
          .setTitle('📬 New Ticket Created')
          .addFields(
            { name: 'User', value: `${user.tag} (${user.id})` },
            { name: 'Channel', value: `${channel}` },
            { name: 'Ticket ID', value: `\`${ticket._id}\`` }
          )
          .setTimestamp();
        
        await logChannel.send({ embeds: [logEmbed] });
      }
    }

    return ticket;
  } catch (error) {
    console.error('❌ Error creating ticket:', error);
    console.error('Stack trace:', error.stack);
    return null;
  }
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  try {
    if (interaction.customId === 'close_ticket') {
      await handleCloseTicket(interaction);
    } else if (interaction.customId === 'claim_ticket') {
      await handleClaimTicket(interaction);
    }
  } catch (error) {
    console.error('Error handling button interaction:', error);
    await interaction.reply({ 
      content: '❌ An error occurred while processing your request.', 
      ephemeral: true 
    }).catch(() => {});
  }
});

async function handleCloseTicket(interaction) {
  const userId = interaction.channel.topic;
  const ticket = await Ticket.findOne({ user_id: userId, status: 'open' });

  if (!ticket) {
    return interaction.reply({ content: '❌ Ticket not found or already closed.', ephemeral: true });
  }

  await interaction.reply('🔒 Closing ticket in 5 seconds...');

  try {
    const user = await client.users.fetch(userId);
    
    const embed = new EmbedBuilder()
      .setColor(0xe74c3c)
      .setTitle('🔒 Ticket Closed')
      .setDescription(`Your ModMail ticket has been closed by ${interaction.user.tag}.`)
      .addFields({ name: 'Ticket ID', value: `\`${ticket._id}\`` })
      .setFooter({ text: 'Thank you for contacting us!' })
      .setTimestamp();

    await user.send({ embeds: [embed] });
  } catch (error) {
    console.error('Error notifying user of ticket closure:', error);
  }

  ticket.status = 'closed';
  ticket.closed_at = new Date();
  ticket.closed_by = interaction.user.id;
  await ticket.save();

  if (process.env.LOG_CHANNEL_ID) {
    const guild = interaction.guild;
    const logChannel = guild.channels.cache.get(process.env.LOG_CHANNEL_ID);
    if (logChannel) {
      const logEmbed = new EmbedBuilder()
        .setColor(0xe74c3c)
        .setTitle('🔒 Ticket Closed')
        .addFields(
          { name: 'Closed By', value: `${interaction.user.tag}` },
          { name: 'Channel', value: `${interaction.channel.name}` },
          { name: 'Ticket ID', value: `\`${ticket._id}\`` }
        )
        .setTimestamp();
      
      await logChannel.send({ embeds: [logEmbed] });
    }
  }

  setTimeout(async () => {
    try {
      await interaction.channel.delete('Ticket closed');
    } catch (err) {
      console.error('Error deleting channel:', err);
    }
  }, 5000);
}

async function handleClaimTicket(interaction) {
  const userId = interaction.channel.topic;
  const ticket = await Ticket.findOne({ user_id: userId, status: 'open' });

  if (!ticket) {
    return interaction.reply({ content: '❌ Ticket not found.', ephemeral: true });
  }

  if (ticket.claimed_by) {
    const claimedUser = await client.users.fetch(ticket.claimed_by).catch(() => null);
    return interaction.reply({ 
      content: `⚠️ This ticket is already claimed by ${claimedUser?.tag || 'another staff member'}.`, 
      ephemeral: true 
    });
  }

  ticket.claimed_by = interaction.user.id;
  ticket.claimed_at = new Date();
  await ticket.save();

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setDescription(`✋ ${interaction.user} has claimed this ticket.`)
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}

client.on('error', error => {
  console.error('Discord client error:', error);
});

client.on('warn', info => {
  console.warn('Discord client warning:', info);
});

process.on('unhandledRejection', error => {
  console.error('Unhandled promise rejection:', error);
});

process.on('uncaughtException', error => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});

process.on('SIGINT', async () => {
  console.log('\n⚠️ Received SIGINT, shutting down gracefully...');
  try {
    await mongoose.connection.close();
    console.log('✅ MongoDB connection closed');
    client.destroy();
    console.log('✅ Discord client destroyed');
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
});

client.login(process.env.DISCORD_TOKEN);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Dashboard server started on port ${PORT}`);
  console.log(`🔗 Access at: ${process.env.DASHBOARD_URL || `http://localhost:${PORT}`}`);
});
