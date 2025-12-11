
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    console.log('Connected to MongoDB');

    const Ticket = mongoose.model('Ticket', new mongoose.Schema({}, { strict: false }), 'tickets');
    const GuildSetting = mongoose.model('GuildSetting', new mongoose.Schema({}, { strict: false }), 'guildsettings');

    const defaultGuild = await GuildSetting.findOne({ is_default: true }).lean().catch(() => null) || await GuildSetting.findOne().lean().catch(() => null);
    const fallbackGuildId = process.env.GUILD_ID || (defaultGuild && defaultGuild.guild_id);

    if (!fallbackGuildId) {
      console.error('No fallback guild id (env GUILD_ID or a default guild in DB). Aborting.');
      process.exit(1);
    }

    const res = await Ticket.updateMany({ guild_id: { $exists: false } }, { $set: { guild_id: fallbackGuildId } });
    console.log('Updated tickets:', res.nModified || res.modifiedCount || res.n);
    process.exit(0);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
})();
