# Mock API Platform Documentation (v1.0)

## Overview

The Mock API Platform provides **real-world backend APIs** for frontend
developers, mobile developers, QA engineers, students, and instructors.

Unlike traditional mock API services that provide unrelated resources
like `/users` or `/posts`, this platform provides **complete business
projects** where every entity is connected through realistic database
relationships.

## Categories

```text
Mock API Platform
│
├── Projects
│   ├── Student ERP
│   ├── E-Commerce
│   ├── Hospital Management
│   ├── HRMS
│   ├── CRM
│   └── Banking
│
└── Single APIs
    ├── Authentication
    ├── Products
    ├── Invoice
    ├── Weather
    ├── Chat
    ├── Payment
    └── etc.
```

# Category 1: Projects

## Purpose

A Project is a **complete backend system** where every module is
connected using realistic business relationships. Developers should be
able to build a complete frontend without writing a backend.

### Example Project

- Authentication
- Students
- Teachers
- Subjects
- Classrooms
- Attendance
- Exams
- Marks
- Fees
- Parents
- Notifications
- Dashboard
- Reports

## Database Relationships

```text
Student
├── belongsTo → Classroom
├── belongsTo → Parent
├── hasMany → Attendance
├── hasMany → Marks
├── hasMany → Fee Payments
└── hasMany → Notifications
```

## Standard Features

- JWT Authentication
- CRUD APIs
- Pagination
- Search
- Filtering
- Sorting
- Include Relations
- Validation Errors
- Business Rules
- Dashboard APIs
- Analytics APIs
- Seed Data
- Role-based Access
- API Documentation

### Standard CRUD

```http
GET    /students
GET    /students/:id
POST   /students
PATCH  /students/:id
DELETE /students/:id
```

### Pagination

```http
GET /students?page=2&limit=20
```

### Search

```http
GET /students?search=John
```

### Sorting

```http
GET /students?sort=name
GET /students?sort=-createdAt
```

### Filtering

```http
GET /students?class=10&status=Active
```

### Include Relations

```http
GET /students/1?include=attendance,marks,parent,classroom
```

# Category 2: Single APIs

Independent APIs that developers can use without importing an entire
project.

Examples:

- Authentication API
- Product API
- Invoice API
- Chat API
- Weather API
- Payment API

## Authentication Endpoints

```http
POST /login
POST /register
POST /refresh
POST /logout
GET  /me
```

# Project Page

Each project should display:

- Total APIs
- Total Database Tables
- ER Diagram
- Relationships
- Authentication Included
- Dashboard Included
- Seed Data Included
- API Documentation

# API Documentation Template

For every endpoint include:

- Endpoint
- Method
- Description
- Authentication Required
- Path Parameters
- Query Parameters
- Request Body
- Success Response
- Error Responses
- Examples

# Example Roadmap

## Phase 1

- Student ERP
- Authentication API
- Product API
- Invoice API

## Phase 2

- E-Commerce
- HRMS
- CRM
- Hospital Management

## Phase 3

- Banking
- Food Delivery
- Hotel Management
- Project Management
- Social Media
- SaaS Billing
- AI Chat Platform

# Vision

Build a library of production-like backend projects with realistic
relationships, authentication, validation, and business workflows. The
objective is to let developers consume realistic APIs and build complete
applications without implementing a backend.
