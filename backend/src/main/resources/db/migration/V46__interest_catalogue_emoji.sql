-- V46__interest_catalogue_emoji — add a per-interest emoji to the catalogue (TM-804, epic Interests)
--
-- The onboarding interests redesign wants a small emoji glyph beside each pickable interest label so
-- the picker reads as a friendly, scannable grid rather than a plain text list. This adds a single
-- nullable `emoji` column to interest_catalogue and back-fills a fitting glyph for every one of the
-- 101 rows seeded in V45.
--
-- NULLABLE by design: an interest with no emoji is valid (the admin create/edit path may add one later,
-- and older rows or future inserts need not carry one), so the client must tolerate a null emoji and
-- fall back to a category default or no glyph. No NOT NULL, no DEFAULT — nulls are a first-class state.
--
-- Flyway owns this DDL; Hibernate runs validate-only, so the InterestCatalogue entity gains a matching
-- nullable `emoji` String field. NEVER edit V45 — this is a forward-only additive migration.

ALTER TABLE interest_catalogue ADD COLUMN emoji TEXT;

-- Back-fill a tasteful emoji for each of the 101 V45 seed interests, matched to the label. Keyed on the
-- label (unique among active rows) so each UPDATE hits exactly the intended row. Any label typo here is
-- a no-op rather than a mis-assignment, and the column stays nullable so an unmatched row is simply left
-- with a null emoji.

-- Sport & Fitness (15)
UPDATE interest_catalogue SET emoji = '⚽' WHERE label = 'Five-a-side football';
UPDATE interest_catalogue SET emoji = '🏃' WHERE label = 'Running & jogging';
UPDATE interest_catalogue SET emoji = '🏅' WHERE label = 'Parkrun';
UPDATE interest_catalogue SET emoji = '🚴' WHERE label = 'Cycling';
UPDATE interest_catalogue SET emoji = '🏋️' WHERE label = 'Gym & weightlifting';
UPDATE interest_catalogue SET emoji = '🧘' WHERE label = 'Yoga';
UPDATE interest_catalogue SET emoji = '🤸' WHERE label = 'Pilates';
UPDATE interest_catalogue SET emoji = '🏊' WHERE label = 'Swimming';
UPDATE interest_catalogue SET emoji = '🎾' WHERE label = 'Tennis';
UPDATE interest_catalogue SET emoji = '🏸' WHERE label = 'Badminton';
UPDATE interest_catalogue SET emoji = '🎾' WHERE label = 'Padel';
UPDATE interest_catalogue SET emoji = '🧗' WHERE label = 'Climbing & bouldering';
UPDATE interest_catalogue SET emoji = '🥋' WHERE label = 'Martial arts';
UPDATE interest_catalogue SET emoji = '🏐' WHERE label = 'Netball';
UPDATE interest_catalogue SET emoji = '🏀' WHERE label = 'Basketball';

-- Outdoors & Nature (15)
UPDATE interest_catalogue SET emoji = '🥾' WHERE label = 'Hiking & rambling';
UPDATE interest_catalogue SET emoji = '🐕' WHERE label = 'Dog walks';
UPDATE interest_catalogue SET emoji = '🏊' WHERE label = 'Wild swimming';
UPDATE interest_catalogue SET emoji = '🛶' WHERE label = 'Kayaking & paddleboarding';
UPDATE interest_catalogue SET emoji = '🏕️' WHERE label = 'Camping';
UPDATE interest_catalogue SET emoji = '🚵' WHERE label = 'Cycling tours';
UPDATE interest_catalogue SET emoji = '🌱' WHERE label = 'Gardening';
UPDATE interest_catalogue SET emoji = '🐦' WHERE label = 'Birdwatching';
UPDATE interest_catalogue SET emoji = '🍄' WHERE label = 'Foraging';
UPDATE interest_catalogue SET emoji = '📷' WHERE label = 'Photography walks';
UPDATE interest_catalogue SET emoji = '🔭' WHERE label = 'Star-gazing';
UPDATE interest_catalogue SET emoji = '🧭' WHERE label = 'Geocaching';
UPDATE interest_catalogue SET emoji = '🎣' WHERE label = 'Fishing';
UPDATE interest_catalogue SET emoji = '🌲' WHERE label = 'Nature conservation';
UPDATE interest_catalogue SET emoji = '🚶' WHERE label = 'Walking';

-- Food & Drink (14)
UPDATE interest_catalogue SET emoji = '☕' WHERE label = 'Coffee & cafés';
UPDATE interest_catalogue SET emoji = '🥞' WHERE label = 'Brunch';
UPDATE interest_catalogue SET emoji = '🍳' WHERE label = 'Cooking';
UPDATE interest_catalogue SET emoji = '🧁' WHERE label = 'Baking';
UPDATE interest_catalogue SET emoji = '🍷' WHERE label = 'Wine tasting';
UPDATE interest_catalogue SET emoji = '🍺' WHERE label = 'Craft beer';
UPDATE interest_catalogue SET emoji = '🍸' WHERE label = 'Cocktails';
UPDATE interest_catalogue SET emoji = '🥗' WHERE label = 'Vegan & veggie';
UPDATE interest_catalogue SET emoji = '🌮' WHERE label = 'Street food';
UPDATE interest_catalogue SET emoji = '🍖' WHERE label = 'BBQ & grilling';
UPDATE interest_catalogue SET emoji = '🍽️' WHERE label = 'Supper clubs';
UPDATE interest_catalogue SET emoji = '🍔' WHERE label = 'Pub food';
UPDATE interest_catalogue SET emoji = '🫖' WHERE label = 'Afternoon tea';
UPDATE interest_catalogue SET emoji = '🥃' WHERE label = 'Whisky & spirits';

-- Arts & Creative (14)
UPDATE interest_catalogue SET emoji = '📷' WHERE label = 'Photography';
UPDATE interest_catalogue SET emoji = '🎨' WHERE label = 'Painting & drawing';
UPDATE interest_catalogue SET emoji = '🏺' WHERE label = 'Pottery & ceramics';
UPDATE interest_catalogue SET emoji = '🔨' WHERE label = 'Crafts & DIY';
UPDATE interest_catalogue SET emoji = '🧶' WHERE label = 'Knitting & crochet';
UPDATE interest_catalogue SET emoji = '✍️' WHERE label = 'Creative writing';
UPDATE interest_catalogue SET emoji = '📜' WHERE label = 'Poetry';
UPDATE interest_catalogue SET emoji = '🎭' WHERE label = 'Theatre';
UPDATE interest_catalogue SET emoji = '🎬' WHERE label = 'Film & cinema';
UPDATE interest_catalogue SET emoji = '🖼️' WHERE label = 'Museums & galleries';
UPDATE interest_catalogue SET emoji = '🖋️' WHERE label = 'Calligraphy';
UPDATE interest_catalogue SET emoji = '💍' WHERE label = 'Jewellery making';
UPDATE interest_catalogue SET emoji = '✏️' WHERE label = 'Sketching';
UPDATE interest_catalogue SET emoji = '🧵' WHERE label = 'Sewing';

-- Games & Tech (14)
UPDATE interest_catalogue SET emoji = '🎲' WHERE label = 'Board games';
UPDATE interest_catalogue SET emoji = '🎮' WHERE label = 'Video gaming';
UPDATE interest_catalogue SET emoji = '♟️' WHERE label = 'Chess';
UPDATE interest_catalogue SET emoji = '🐉' WHERE label = 'Tabletop RPGs (D&D)';
UPDATE interest_catalogue SET emoji = '🃏' WHERE label = 'Card games';
UPDATE interest_catalogue SET emoji = '❓' WHERE label = 'Trivia & pub quiz';
UPDATE interest_catalogue SET emoji = '🔑' WHERE label = 'Escape rooms';
UPDATE interest_catalogue SET emoji = '🧩' WHERE label = 'Puzzles & crosswords';
UPDATE interest_catalogue SET emoji = '💻' WHERE label = 'Coding & hackathons';
UPDATE interest_catalogue SET emoji = '👥' WHERE label = 'Tech meetups';
UPDATE interest_catalogue SET emoji = '🤖' WHERE label = 'AI & machine learning';
UPDATE interest_catalogue SET emoji = '🚀' WHERE label = 'Startups & founders';
UPDATE interest_catalogue SET emoji = '🕹️' WHERE label = 'Retro gaming';
UPDATE interest_catalogue SET emoji = '🏆' WHERE label = 'Esports';

-- Music & Nightlife (13)
UPDATE interest_catalogue SET emoji = '🎸' WHERE label = 'Live music & gigs';
UPDATE interest_catalogue SET emoji = '🎧' WHERE label = 'DJ & electronic';
UPDATE interest_catalogue SET emoji = '🎤' WHERE label = 'Karaoke';
UPDATE interest_catalogue SET emoji = '🎙️' WHERE label = 'Open mic';
UPDATE interest_catalogue SET emoji = '💃' WHERE label = 'Dancing & salsa';
UPDATE interest_catalogue SET emoji = '🎪' WHERE label = 'Festivals';
UPDATE interest_catalogue SET emoji = '🎷' WHERE label = 'Jazz';
UPDATE interest_catalogue SET emoji = '💿' WHERE label = 'Vinyl & records';
UPDATE interest_catalogue SET emoji = '🎶' WHERE label = 'Choir & singing';
UPDATE interest_catalogue SET emoji = '🎹' WHERE label = 'Learning an instrument';
UPDATE interest_catalogue SET emoji = '🕺' WHERE label = 'Clubbing';
UPDATE interest_catalogue SET emoji = '🎚️' WHERE label = 'Music production';
UPDATE interest_catalogue SET emoji = '🪕' WHERE label = 'Folk & acoustic';

-- Social & Wellbeing (16)
UPDATE interest_catalogue SET emoji = '📚' WHERE label = 'Book club';
UPDATE interest_catalogue SET emoji = '🗣️' WHERE label = 'Language exchange';
UPDATE interest_catalogue SET emoji = '🤝' WHERE label = 'Volunteering';
UPDATE interest_catalogue SET emoji = '🤝' WHERE label = 'Networking';
UPDATE interest_catalogue SET emoji = '📍' WHERE label = 'New in town';
UPDATE interest_catalogue SET emoji = '👶' WHERE label = 'Parents & little ones';
UPDATE interest_catalogue SET emoji = '🧓' WHERE label = '50+ social';
UPDATE interest_catalogue SET emoji = '🧘' WHERE label = 'Meditation & mindfulness';
UPDATE interest_catalogue SET emoji = '💚' WHERE label = 'Mental-health peer support';
UPDATE interest_catalogue SET emoji = '🚶' WHERE label = 'Walk & talk';
UPDATE interest_catalogue SET emoji = '☕' WHERE label = 'Coffee & chat';
UPDATE interest_catalogue SET emoji = '🎗️' WHERE label = 'Charity & fundraising';
UPDATE interest_catalogue SET emoji = '🙏' WHERE label = 'Faith & spirituality';
UPDATE interest_catalogue SET emoji = '😮‍💨' WHERE label = 'Breathwork';
UPDATE interest_catalogue SET emoji = '📓' WHERE label = 'Journaling';
UPDATE interest_catalogue SET emoji = '🌻' WHERE label = 'Community gardening';
