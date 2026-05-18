import { z } from "zod";
import type { Bot } from 'mineflayer';
import { ToolFactory } from '../tool-factory.js';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals, Movements } = pathfinderPkg;
import minecraftData from 'minecraft-data';

const { GoalFollow, GoalNear } = goals;

// Track active behaviors so stop() can cancel them
let followInterval: ReturnType<typeof setInterval> | null = null;
let isDefending = false;
let defendListener: ((attacker: unknown) => void) | null = null;

function clearFollow(bot: Bot) {
  if (followInterval) {
    clearInterval(followInterval);
    followInterval = null;
  }
  bot.pathfinder.setGoal(null);
}

function clearDefend(bot: Bot) {
  if (defendListener) {
    bot.removeListener('entityHurt', defendListener as (...args: unknown[]) => void);
    defendListener = null;
  }
  isDefending = false;
  // @ts-ignore
  if (bot.pvp) bot.pvp.stop();
}

export function registerAutonomousTools(factory: ToolFactory, getBot: () => Bot): void {

  // ── FOLLOW PLAYER ──────────────────────────────────────────────────────────
  factory.registerTool(
    "follow-player",
    "Continuously follow a player, staying within a set distance. CALEB will pathfind around obstacles to keep up. Use stop() to cancel.",
    {
      username: z.string().describe("The exact in-game username of the player to follow"),
      distance: z.coerce.number().finite().optional().describe("How close to stay in blocks (default: 3)")
    },
    async ({ username, distance = 3 }) => {
      const bot = getBot();

      // Cancel any existing follow
      clearFollow(bot);

      const mcData = minecraftData(bot.version);
      const movements = new Movements(bot, mcData);
      bot.pathfinder.setMovements(movements);

      const target = bot.players[username]?.entity;
      if (!target) {
        return factory.createResponse(`Cannot find player ${username} — are they in the game and nearby?`);
      }

      bot.pathfinder.setGoal(new GoalFollow(target, distance), true);

      // Keep goal updated as player moves
      followInterval = setInterval(() => {
        try {
          const currentTarget = bot.players[username]?.entity;
          if (currentTarget) {
            bot.pathfinder.setGoal(new GoalFollow(currentTarget, distance), true);
          }
        } catch {
          // Bot may have disconnected
        }
      }, 1000);

      return factory.createResponse(`Now following ${username}, staying within ${distance} blocks. Call stop to cancel.`);
    }
  );

  // ── STOP ───────────────────────────────────────────────────────────────────
  factory.registerTool(
    "stop",
    "Stop all active autonomous behaviors — cancels following, pathfinding, and combat. Returns CALEB to idle.",
    {},
    async () => {
      const bot = getBot();
      clearFollow(bot);
      clearDefend(bot);
      bot.pathfinder.setGoal(null);
      return factory.createResponse("Stopped all active behaviors. Standing by.");
    }
  );

  // ── ATTACK ENTITY ──────────────────────────────────────────────────────────
  factory.registerTool(
    "attack-entity",
    "Attack the nearest hostile mob, or a specific named entity. CALEB will pathfind to it and attack until it dies or stop() is called.",
    {
      target: z.string().optional().describe("Entity type or name to attack (e.g. 'zombie', 'skeleton'). Leave empty for nearest hostile mob."),
      maxDistance: z.coerce.number().finite().optional().describe("Maximum distance to search for target (default: 16)")
    },
    async ({ target = '', maxDistance = 16 }) => {
      const bot = getBot();

      // @ts-ignore
      if (!bot.pvp) {
        return factory.createResponse("PvP module not available. Check that mineflayer-pvp is installed.");
      }

      const entityFilter = (entity: NonNullable<ReturnType<Bot['nearestEntity']>>) => {
        if (target) {
          return Boolean(entity.name && entity.name.toLowerCase().includes(target.toLowerCase()));
        }
        // Default: nearest hostile mob
        const hostileMobs = ['zombie', 'skeleton', 'creeper', 'spider', 'enderman',
          'witch', 'pillager', 'vindicator', 'phantom', 'drowned', 'husk',
          'stray', 'blaze', 'ghast', 'slime', 'magma_cube'];
        return Boolean(entity.name && hostileMobs.includes(entity.name.toLowerCase()));
      };

      const entity = bot.nearestEntity(entityFilter);
      if (!entity || bot.entity.position.distanceTo(entity.position) > maxDistance) {
        const targetDesc = target || 'hostile mob';
        return factory.createResponse(`No ${targetDesc} found within ${maxDistance} blocks.`);
      }

      const entityName = entity.name || entity.type;
      // @ts-ignore
      bot.pvp.attack(entity);

      return factory.createResponse(`Attacking ${entityName}. Call stop to cancel.`);
    }
  );

  // ── DEFEND SELF ────────────────────────────────────────────────────────────
  factory.registerTool(
    "defend-self",
    "Enable automatic self-defense. CALEB will automatically attack any entity that hurts him until stop() is called. Call this once to arm it.",
    {
      enabled: z.boolean().optional().describe("True to enable auto-defend, false to disable (default: true)")
    },
    async ({ enabled = true }) => {
      const bot = getBot();

      // @ts-ignore
      if (!bot.pvp) {
        return factory.createResponse("PvP module not available.");
      }

      if (!enabled) {
        clearDefend(bot);
        return factory.createResponse("Auto-defend disabled.");
      }

      if (isDefending) {
        return factory.createResponse("Auto-defend is already active.");
      }

      defendListener = (attacker: unknown) => {
        try {
          const attackerEntity = attacker as NonNullable<ReturnType<Bot['nearestEntity']>>;
          if (attackerEntity && attackerEntity.type !== 'player') {
            // @ts-ignore
            bot.pvp.attack(attackerEntity);
          }
        } catch {
          // Entity may have despawned
        }
      };

      bot.on('entityHurt', defendListener as (...args: unknown[]) => void);
      isDefending = true;

      return factory.createResponse("Auto-defend enabled. CALEB will fight back if attacked. Call stop or defend-self with enabled=false to cancel.");
    }
  );

  // ── GET NEARBY ENTITIES ────────────────────────────────────────────────────
  factory.registerTool(
    "get-nearby-entities",
    "Get a detailed list of all entities within a radius — players, mobs, animals, items. Includes distance, direction, and threat assessment. Useful for situational awareness.",
    {
      radius: z.coerce.number().finite().optional().describe("Search radius in blocks (default: 20)"),
      type: z.string().optional().describe("Filter by type: 'player', 'mob', 'animal', 'item', or empty for all")
    },
    async ({ radius = 20, type = '' }) => {
      const bot = getBot();

      const hostileMobs = ['zombie', 'skeleton', 'creeper', 'spider', 'enderman',
        'witch', 'pillager', 'vindicator', 'phantom', 'drowned', 'husk',
        'stray', 'blaze', 'ghast', 'slime', 'magma_cube'];

      const passiveMobs = ['cow', 'pig', 'sheep', 'chicken', 'horse', 'donkey',
        'rabbit', 'fox', 'wolf', 'cat', 'axolotl', 'bee', 'turtle'];

      const botPos = bot.entity.position;
      const nearby: string[] = [];

      for (const entity of Object.values(bot.entities)) {
        if (entity === bot.entity) continue;

        const dist = botPos.distanceTo(entity.position);
        if (dist > radius) continue;

        const name = entity.name || (entity as { username?: string }).username || entity.type;
        const isHostile = entity.name && hostileMobs.includes(entity.name.toLowerCase());
        const isPassive = entity.name && passiveMobs.includes(entity.name.toLowerCase());

        // Direction calculation
        const dx = entity.position.x - botPos.x;
        const dz = entity.position.z - botPos.z;
        const angle = Math.atan2(dx, dz) * (180 / Math.PI);
        const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
        const direction = directions[Math.round(((angle + 360) % 360) / 45) % 8];

        // Type filter
        if (type) {
          if (type === 'player' && entity.type !== 'player') continue;
          if (type === 'mob' && !isHostile) continue;
          if (type === 'animal' && !isPassive) continue;
          if (type === 'item' && entity.type !== 'object') continue;
        }

        const threat = isHostile ? ' ⚠ HOSTILE' : isPassive ? ' (passive)' : '';
        nearby.push(`${name}${threat} — ${Math.floor(dist)} blocks ${direction} at (${Math.floor(entity.position.x)}, ${Math.floor(entity.position.y)}, ${Math.floor(entity.position.z)})`);
      }

      if (nearby.length === 0) {
        return factory.createResponse(`No ${type || 'entities'} found within ${radius} blocks.`);
      }

      nearby.sort(); // Group by name roughly
      return factory.createResponse(`Entities within ${radius} blocks:\n${nearby.join('\n')}`);
    }
  );

  // ── GET HEALTH STATUS ──────────────────────────────────────────────────────
  factory.registerTool(
    "get-health-status",
    "Get CALEB's current health, food level, saturation, oxygen, and experience. Use this to assess survival situation.",
    {},
    async () => {
      const bot = getBot();

      const health = Math.floor(bot.health ?? 0);
      const food = Math.floor(bot.food ?? 0);
      const saturation = Math.floor(bot.foodSaturation ?? 0);
      const oxygen = Math.floor(bot.oxygenLevel ?? 20);
      const xp = bot.experience?.level ?? 0;

      const healthStatus = health >= 16 ? 'good' : health >= 8 ? 'moderate' : 'critical';
      const foodStatus = food >= 16 ? 'full' : food >= 8 ? 'hungry' : 'starving';

      return factory.createResponse(
        `Health: ${health}/20 (${healthStatus})\n` +
        `Food: ${food}/20 (${foodStatus}), Saturation: ${saturation}\n` +
        `Oxygen: ${oxygen}/20\n` +
        `XP Level: ${xp}`
      );
    }
  );

  // ── EAT FOOD ──────────────────────────────────────────────────────────────
  factory.registerTool(
    "eat-food",
    "Eat the best available food from inventory to restore health and hunger. CALEB will automatically select the most nutritious food item available.",
    {
      foodName: z.string().optional().describe("Specific food item name to eat. Leave empty to auto-select best available.")
    },
    async ({ foodName = '' }) => {
      const bot = getBot();

      // Food items ranked by nutrition value (rough priority order)
      const foodPriority = [
        'cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_salmon',
        'cooked_chicken', 'cooked_cod', 'bread', 'baked_potato',
        'apple', 'carrot', 'potato', 'melon_slice', 'cookie'
      ];

      let itemToEat: string | null = null;

      if (foodName) {
        itemToEat = foodName;
      } else {
        // Find best food in inventory
        for (const food of foodPriority) {
          const item = bot.inventory.items().find(i => i.name === food);
          if (item) {
            itemToEat = food;
            break;
          }
        }
      }

      if (!itemToEat) {
        return factory.createResponse("No suitable food found in inventory.");
      }

      const item = bot.inventory.items().find(i => i.name === itemToEat);
      if (!item) {
        return factory.createResponse(`${foodName || 'Requested food'} not found in inventory.`);
      }

      try {
        await bot.equip(item, 'hand');
        await bot.consume();
        return factory.createResponse(`Ate ${item.name}. Health: ${Math.floor(bot.health)}/20, Food: ${Math.floor(bot.food)}/20`);
      } catch (err) {
        return factory.createErrorResponse(err as Error);
      }
    }
  );
}
