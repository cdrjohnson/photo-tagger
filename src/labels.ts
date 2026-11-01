// Built-in label vocabulary for CLIP zero-shot tagging.
// Plain data only (no imports) so scripts/embed-labels.mjs can load it directly.
// Each label has one or more text prompts; their CLIP text embeddings are averaged.
// `implies` adds extra tags (e.g. dog -> pets, animals).

export interface LabelDef {
  id: string
  label: string
  group: string
  prompts: string[]
  implies?: string[]
  builtin?: boolean
  enabled?: boolean
}

const L = (id: string, group: string, prompts: string[], implies?: string[], label = id): LabelDef => ({
  id, label, group, prompts, implies, builtin: true, enabled: true,
})

export const DEFAULT_LABELS: LabelDef[] = [
  // People
  L('people', 'People', ['a photo of a person', 'a photo of people', 'a portrait of a person', 'a photo of a man', 'a photo of a woman']),
  L('group', 'People', ['a group photo of several people', 'a photo of a crowd of people', 'friends posing together'], ['people'], 'group'),
  L('selfie', 'People', ['a selfie', 'a selfie of a person taken with a phone'], ['people']),
  L('baby', 'People', ['a photo of a baby', 'a photo of a toddler'], ['people']),
  L('child', 'People', ['a photo of a child', 'children playing'], ['people']),
  L('wedding', 'Events', ['a wedding photo', 'a bride and groom'], ['people']),
  L('party', 'Events', ['a photo of a party', 'people celebrating at a party']),
  L('concert', 'Events', ['a photo of a concert', 'a crowd at a music concert on stage']),
  L('sports', 'Events', ['a photo of people playing sports', 'a sports game'], ['outdoors']),
  L('birthday', 'Events', ['a birthday cake with candles', 'a birthday party']),
  L('holiday', 'Events', ['a christmas tree with decorations', 'holiday decorations', 'halloween pumpkins'], undefined, 'holiday'),
  L('fireworks', 'Events', ['a photo of fireworks in the night sky']),
  // Animals
  L('dog', 'Animals', ['a photo of a dog', 'a photo of a puppy'], ['pets', 'animals']),
  L('cat', 'Animals', ['a photo of a cat', 'a photo of a kitten'], ['pets', 'animals']),
  L('bird', 'Animals', ['a photo of a bird'], ['animals']),
  L('horse', 'Animals', ['a photo of a horse'], ['animals']),
  L('fish', 'Animals', ['a photo of a fish underwater', 'an aquarium with fish'], ['animals']),
  L('wildlife', 'Animals', ['a photo of a wild animal in nature', 'a photo of an elephant', 'a photo of a deer', 'a photo of a bear'], ['animals']),
  L('insect', 'Animals', ['a close-up photo of an insect', 'a photo of a butterfly', 'a photo of a bee'], ['animals']),
  L('farm animal', 'Animals', ['a photo of a cow', 'a photo of sheep', 'a photo of a chicken'], ['animals']),
  // Food
  L('food', 'Food & drink', ['a photo of food', 'a photo of a plate of food', 'a photo of a meal on a table']),
  L('pizza', 'Food & drink', ['a photo of a pizza'], ['food']),
  L('burger', 'Food & drink', ['a photo of a burger', 'a photo of fast food', 'a photo of french fries'], ['food']),
  L('dessert', 'Food & drink', ['a photo of a dessert', 'a photo of a cake', 'a photo of ice cream'], ['food']),
  L('fruit', 'Food & drink', ['a photo of fruit', 'a photo of vegetables'], ['food']),
  L('coffee', 'Food & drink', ['a photo of a cup of coffee', 'a photo of a latte']),
  L('drink', 'Food & drink', ['a photo of a glass of wine', 'a photo of a beer', 'a photo of a cocktail']),
  L('cooking', 'Food & drink', ['a photo of someone cooking in a kitchen', 'ingredients for cooking']),
  // Nature & places
  L('landscape', 'Nature', ['a landscape photo', 'a scenic view of nature'], ['outdoors']),
  L('mountain', 'Nature', ['a photo of mountains', 'a photo of a mountain peak'], ['landscape', 'outdoors']),
  L('beach', 'Nature', ['a photo of a beach', 'a photo of a sandy beach with waves'], ['outdoors']),
  L('ocean', 'Nature', ['a photo of the ocean', 'a photo of the sea'], ['outdoors']),
  L('lake', 'Nature', ['a photo of a lake', 'a photo of a river'], ['outdoors']),
  L('waterfall', 'Nature', ['a photo of a waterfall'], ['outdoors']),
  L('forest', 'Nature', ['a photo of a forest', 'a photo of trees in the woods'], ['outdoors']),
  L('desert', 'Nature', ['a photo of a desert', 'a photo of sand dunes', 'a photo of red rock canyon'], ['outdoors']),
  L('snow', 'Nature', ['a photo of snow', 'a photo of a snowy landscape', 'a photo of skiing'], ['outdoors']),
  L('sunset', 'Nature', ['a photo of a sunset', 'a photo of a sunrise'], ['outdoors']),
  L('sky', 'Nature', ['a photo of clouds in the sky', 'a photo of a blue sky'], ['outdoors']),
  L('flowers', 'Nature', ['a photo of flowers', 'a close-up photo of a blossom'], ['plants']),
  L('garden', 'Nature', ['a photo of a garden', 'a photo of a lawn and plants'], ['plants', 'outdoors']),
  L('farmland', 'Nature', ['a photo of a farm field', 'a photo of crops and farmland'], ['outdoors']),
  // Urban & buildings
  L('city', 'Urban', ['a photo of a city', 'a photo of a city skyline with skyscrapers'], ['outdoors']),
  L('street', 'Urban', ['a photo of a city street', 'a photo of a road with traffic'], ['outdoors']),
  L('building', 'Urban', ['a photo of a building', 'a photo of a house exterior'], ['architecture']),
  L('architecture', 'Urban', ['a photo of interesting architecture', 'a photo of a historic monument']),
  L('church', 'Urban', ['a photo of a church', 'a photo of a cathedral', 'a photo of a temple or mosque'], ['architecture']),
  L('castle', 'Urban', ['a photo of a castle', 'a photo of ancient ruins'], ['architecture']),
  L('bridge', 'Urban', ['a photo of a bridge'], ['outdoors']),
  L('night', 'Scene', ['a photo taken at night', 'a night scene with city lights']),
  L('indoors', 'Scene', ['a photo taken indoors', 'a photo of a room interior']),
  L('outdoors', 'Scene', ['a photo taken outdoors']),
  L('kitchen', 'Scene', ['a photo of a kitchen'], ['indoors']),
  L('bedroom', 'Scene', ['a photo of a bedroom'], ['indoors']),
  L('living room', 'Scene', ['a photo of a living room with a sofa'], ['indoors']),
  L('office', 'Scene', ['a photo of an office', 'a photo of a desk with a computer'], ['indoors']),
  L('restaurant', 'Scene', ['a photo inside a restaurant', 'a photo of a cafe'], ['indoors']),
  L('museum', 'Scene', ['a photo inside a museum', 'an art gallery interior'], ['indoors']),
  // Transport
  L('car', 'Transport', ['a photo of a car', 'a photo of a vehicle on a road']),
  L('motorcycle', 'Transport', ['a photo of a motorcycle', 'a photo of a bicycle']),
  L('train', 'Transport', ['a photo of a train', 'a photo of a train station']),
  L('airplane', 'Transport', ['a photo of an airplane', 'a photo from an airplane window', 'an airport']),
  L('boat', 'Transport', ['a photo of a boat', 'a photo of a ship', 'a sailboat'], ['outdoors']),
  L('bus', 'Transport', ['a photo of a bus', 'a photo of a tram']),
  // Documents & screens
  L('document', 'Documents', ['a scan of a text document', 'a photo of a printed page of text', 'a scanned page of a book'], ['text']),
  L('receipt', 'Documents', ['a photo of a receipt', 'a photo of an invoice or bill'], ['text']),
  L('whiteboard', 'Documents', ['a photo of a whiteboard with writing', 'a photo of a presentation slide']),
  L('screenshot', 'Documents', ['a screenshot of a computer screen', 'a screenshot of a phone app', 'a screenshot of a website'], ['screen']),
  L('meme', 'Documents', ['a meme with text over an image', 'a funny internet meme']),
  L('sign', 'Documents', ['a photo of a street sign', 'a photo of a poster or billboard with text'], ['text']),
  L('map', 'Documents', ['a map', 'a screenshot of a map app']),
  L('chart', 'Documents', ['a chart or graph', 'a diagram', 'a spreadsheet']),
  L('book', 'Documents', ['a photo of a book', 'a photo of a magazine'], ['text']),
  L('qr code', 'Documents', ['a qr code', 'a barcode']),
  // Art & objects
  L('art', 'Art & objects', ['a painting', 'a drawing', 'a piece of artwork'], undefined),
  L('illustration', 'Art & objects', ['a digital illustration', 'a cartoon', 'an anime drawing']),
  L('statue', 'Art & objects', ['a photo of a statue', 'a photo of a sculpture']),
  L('toy', 'Art & objects', ['a photo of a toy', 'a photo of lego', 'a photo of a stuffed animal']),
  L('product', 'Art & objects', ['a product photo on a white background', 'a photo of a gadget'], undefined),
  L('electronics', 'Art & objects', ['a photo of a laptop', 'a photo of a smartphone', 'a photo of a television']),
  L('clothing', 'Art & objects', ['a photo of clothing', 'a photo of shoes', 'a photo of fashion'], undefined),
  L('furniture', 'Art & objects', ['a photo of furniture', 'a photo of a chair or table'], ['indoors']),
  L('tools', 'Art & objects', ['a photo of tools', 'a photo of a workshop or garage']),
  L('jewelry', 'Art & objects', ['a photo of jewelry', 'a photo of a wristwatch']),
  L('musical instrument', 'Art & objects', ['a photo of a guitar', 'a photo of a piano', 'a photo of a musical instrument']),
  L('space', 'Nature', ['a photo of the moon', 'a photo of stars and the milky way', 'a photo of a planet', 'a photo of an astronaut in space']),
  L('pattern', 'Scene', ['an abstract pattern', 'a texture or background', 'a close-up of a surface']),
  L('macro', 'Scene', ['a macro close-up photo of a small object']),
  L('aerial', 'Scene', ['an aerial photo taken from a drone', 'a satellite view from above'], ['outdoors']),
  L('black and white', 'Scene', ['a black and white photograph', 'a monochrome photo']),
]

/** Tags that are implied by other tags and never scored on their own (no prompt needed). */
export const IMPLIED_ONLY = ['pets', 'animals', 'plants', 'text', 'screen']

export const CLIP_PROMPT_TEMPLATE = (label: string) => `a photo of ${label}`
export const MODEL_ID = 'Xenova/clip-vit-base-patch32'
