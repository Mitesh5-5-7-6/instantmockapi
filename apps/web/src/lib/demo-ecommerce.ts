export type DemoField = {
  name: string;
  type: string;
  key?: 'primary' | 'foreign';
  nullable?: boolean;
};

export type DemoEntity = {
  name: string;
  label: string;
  description: string;
  color: string;
  fields: DemoField[];
  recordCount: string;
};

export type DemoRelationship = {
  from: string;
  to: string;
  cardinality: '1:1' | '1:N' | 'N:1' | 'N:M';
  label: string;
};

export type DemoEndpoint = {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  group: string;
  description: string;
  auth: string;
  response: string;
};

export const demoEntities: DemoEntity[] = [
  {
    name: 'users',
    label: 'Users',
    description: 'Identity records for everyone operating the platform.',
    color: '#6f9cff',
    recordCount: '1,284',
    fields: [
      { name: 'id', type: 'uuid', key: 'primary' },
      { name: 'role_id', type: 'uuid', key: 'foreign' },
      { name: 'email', type: 'string' },
      { name: 'status', type: 'enum' },
      { name: 'created_at', type: 'datetime' },
    ],
  },
  {
    name: 'roles',
    label: 'Roles',
    description: 'Access profiles used by administrators and operators.',
    color: '#b485ff',
    recordCount: '5',
    fields: [
      { name: 'id', type: 'uuid', key: 'primary' },
      { name: 'name', type: 'string' },
      { name: 'permissions', type: 'string[]' },
    ],
  },
  {
    name: 'customers',
    label: 'Customers',
    description: 'Commerce profiles connected to orders and saved addresses.',
    color: '#30c6bc',
    recordCount: '842',
    fields: [
      { name: 'id', type: 'uuid', key: 'primary' },
      { name: 'user_id', type: 'uuid', key: 'foreign' },
      { name: 'first_name', type: 'string' },
      { name: 'last_name', type: 'string' },
      { name: 'phone', type: 'string', nullable: true },
    ],
  },
  {
    name: 'addresses',
    label: 'Addresses',
    description: 'Billing and delivery destinations for customers.',
    color: '#30c6bc',
    recordCount: '1,106',
    fields: [
      { name: 'id', type: 'uuid', key: 'primary' },
      { name: 'customer_id', type: 'uuid', key: 'foreign' },
      { name: 'line_1', type: 'string' },
      { name: 'city', type: 'string' },
      { name: 'country', type: 'string' },
    ],
  },
  {
    name: 'categories',
    label: 'Categories',
    description: 'The navigable product taxonomy, including nested groups.',
    color: '#e3a008',
    recordCount: '18',
    fields: [
      { name: 'id', type: 'uuid', key: 'primary' },
      { name: 'parent_id', type: 'uuid', key: 'foreign', nullable: true },
      { name: 'name', type: 'string' },
      { name: 'slug', type: 'string' },
    ],
  },
  {
    name: 'products',
    label: 'Products',
    description: 'Sellable catalog items with price, brand, and inventory.',
    color: '#e3a008',
    recordCount: '246',
    fields: [
      { name: 'id', type: 'uuid', key: 'primary' },
      { name: 'category_id', type: 'uuid', key: 'foreign' },
      { name: 'sku', type: 'string' },
      { name: 'name', type: 'string' },
      { name: 'price', type: 'decimal' },
      { name: 'active', type: 'boolean' },
    ],
  },
  {
    name: 'inventory',
    label: 'Inventory',
    description: 'Stock position and reorder signals for every product.',
    color: '#e3a008',
    recordCount: '246',
    fields: [
      { name: 'id', type: 'uuid', key: 'primary' },
      { name: 'product_id', type: 'uuid', key: 'foreign' },
      { name: 'available', type: 'integer' },
      { name: 'reserved', type: 'integer' },
      { name: 'reorder_level', type: 'integer' },
    ],
  },
  {
    name: 'orders',
    label: 'Orders',
    description: 'The central transaction record from checkout to delivery.',
    color: '#f57978',
    recordCount: '3,691',
    fields: [
      { name: 'id', type: 'uuid', key: 'primary' },
      { name: 'customer_id', type: 'uuid', key: 'foreign' },
      { name: 'status', type: 'enum' },
      { name: 'total', type: 'decimal' },
      { name: 'placed_at', type: 'datetime' },
    ],
  },
  {
    name: 'order_items',
    label: 'Order items',
    description: 'Immutable product snapshots captured at checkout.',
    color: '#f57978',
    recordCount: '9,408',
    fields: [
      { name: 'id', type: 'uuid', key: 'primary' },
      { name: 'order_id', type: 'uuid', key: 'foreign' },
      { name: 'product_id', type: 'uuid', key: 'foreign' },
      { name: 'quantity', type: 'integer' },
      { name: 'unit_price', type: 'decimal' },
    ],
  },
  {
    name: 'payments',
    label: 'Payments',
    description: 'Payment attempts, captures, refunds, and provider references.',
    color: '#f57978',
    recordCount: '3,744',
    fields: [
      { name: 'id', type: 'uuid', key: 'primary' },
      { name: 'order_id', type: 'uuid', key: 'foreign' },
      { name: 'provider', type: 'enum' },
      { name: 'status', type: 'enum' },
      { name: 'amount', type: 'decimal' },
    ],
  },
  {
    name: 'shipments',
    label: 'Shipments',
    description: 'Delivery lifecycle and carrier tracking information.',
    color: '#aa92ff',
    recordCount: '3,102',
    fields: [
      { name: 'id', type: 'uuid', key: 'primary' },
      { name: 'order_id', type: 'uuid', key: 'foreign' },
      { name: 'address_id', type: 'uuid', key: 'foreign' },
      { name: 'carrier', type: 'string' },
      { name: 'tracking_number', type: 'string' },
      { name: 'status', type: 'enum' },
    ],
  },
  {
    name: 'reviews',
    label: 'Reviews',
    description: 'Verified customer feedback attached to catalog products.',
    color: '#30c6bc',
    recordCount: '1,976',
    fields: [
      { name: 'id', type: 'uuid', key: 'primary' },
      { name: 'product_id', type: 'uuid', key: 'foreign' },
      { name: 'customer_id', type: 'uuid', key: 'foreign' },
      { name: 'rating', type: 'integer' },
      { name: 'body', type: 'text' },
    ],
  },
];

export const demoRelationships: DemoRelationship[] = [
  { from: 'roles', to: 'users', cardinality: '1:N', label: 'grants access to' },
  { from: 'users', to: 'customers', cardinality: '1:1', label: 'has profile' },
  { from: 'customers', to: 'addresses', cardinality: '1:N', label: 'saves' },
  { from: 'categories', to: 'products', cardinality: '1:N', label: 'contains' },
  { from: 'categories', to: 'categories', cardinality: '1:N', label: 'nests' },
  { from: 'products', to: 'inventory', cardinality: '1:1', label: 'is stocked by' },
  { from: 'customers', to: 'orders', cardinality: '1:N', label: 'places' },
  { from: 'orders', to: 'order_items', cardinality: '1:N', label: 'contains' },
  { from: 'products', to: 'order_items', cardinality: '1:N', label: 'is purchased as' },
  { from: 'orders', to: 'payments', cardinality: '1:N', label: 'records' },
  { from: 'orders', to: 'shipments', cardinality: '1:N', label: 'fulfills through' },
  { from: 'addresses', to: 'shipments', cardinality: '1:N', label: 'delivers to' },
  { from: 'products', to: 'reviews', cardinality: '1:N', label: 'receives' },
  { from: 'customers', to: 'reviews', cardinality: '1:N', label: 'writes' },
];

export const demoEndpoints: DemoEndpoint[] = [
  {
    method: 'POST',
    path: '/auth/login',
    group: 'Authentication',
    description: 'Exchange demo credentials for an access token.',
    auth: 'Public',
    response: '{ "accessToken": "demo_token_...", "user": { "role": "customer" } }',
  },
  {
    method: 'GET',
    path: '/products?category=audio&sort=-rating',
    group: 'Catalog',
    description: 'Browse active products with filtering, sorting, and pagination.',
    auth: 'Bearer token',
    response:
      '{ "data": [{ "id": "prod_101", "name": "Studio Headphones", "price": 189 }], "meta": { "total": 42 } }',
  },
  {
    method: 'GET',
    path: '/customers/cus_204?include=addresses,orders',
    group: 'Customers',
    description: 'Fetch a customer and selected related resources in one request.',
    auth: 'Bearer token',
    response: '{ "id": "cus_204", "name": "Maya Patel", "addresses": [], "orders": [] }',
  },
  {
    method: 'POST',
    path: '/orders',
    group: 'Orders',
    description: 'Create an order from a customer cart and reserve inventory.',
    auth: 'Bearer token',
    response: '{ "id": "ord_3692", "status": "pending", "total": 247.5 }',
  },
  {
    method: 'POST',
    path: '/orders/ord_3692/payments',
    group: 'Payments',
    description: 'Create a payment attempt for an existing order.',
    auth: 'Bearer token',
    response: '{ "id": "pay_7741", "status": "captured", "provider": "stripe" }',
  },
  {
    method: 'GET',
    path: '/shipments/shp_912/status',
    group: 'Delivery',
    description: 'Read delivery status and carrier tracking events.',
    auth: 'Bearer token',
    response: '{ "status": "in_transit", "carrier": "DHL", "estimatedDelivery": "2026-08-29" }',
  },
];

export const demoGroups = [...new Set(demoEndpoints.map((endpoint) => endpoint.group))];
