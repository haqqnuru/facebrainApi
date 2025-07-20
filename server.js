const express = require('express');
const bodyParser = require('body-parser');
const bcrypt = require('bcrypt-nodejs');
const cors = require('cors');
require('dotenv').config();
const { ClarifaiStub, grpc } = require("clarifai-nodejs-grpc");
const knex = require('knex')


// call the database
const db = knex({
    client: 'pg',
    connection: {
      host: '127.0.0.1',
      port: 5432,
      user: 'postgres',
      password: '1234',
      database: 'facebrain',
    },
  });

//this creates the “connection” to Clarifai’s services
const stub = ClarifaiStub.grpc();
const metadata = new grpc.Metadata();
metadata.set("authorization", `Key ${process.env.CLARIFAI_API_KEY}`);

// This initializes the Express app.
const app = express();
//This lets Express parse incoming JSON in request bodies.
app.use(bodyParser.json());
//This allows the frontend to make requests to the backend without being blocked.
app.use(cors());

// Test only - when you have a database variable you want to use
app.get('/', (req, res) => {
    res.send(database.users);
});

// This accesses the data you input in the signin page.
app.post('/signin', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    console.log('Missing email or password:', req.body);
    return res.status(400).json('incorrect form submission');
  }

  db.select('email', 'hash').from('login')
    .where('email', '=', email)
    .then(data => {
      if (data.length === 0) {
        console.log('No user found for email:', email);
        return res.status(400).json('wrong credentials');
      }

      const isValid = bcrypt.compareSync(password, data[0].hash);
      if (isValid) {
        return db.select('*').from('users')
          .where('email', '=', email)
          .then(user => {
            res.json(user[0]);
          })
          .catch(err => {
            console.log('Error fetching user:', err);
            res.status(400).json('unable to get user');
          });
      } else {
        console.log('Invalid password for email:', email);
        res.status(400).json('wrong credentials');
      }
    })
    .catch(err => {
      console.log('Signin error:', err);
      res.status(400).json('wrong credentials');
    });
});


// This accesses the data you input in the register page.
app.post('/register', (req, res) => {
  const { email, name, password } = req.body;
  
  // Validate input
  if (!email || !name || !password) {
    return res.status(400).json({
      success: false,
      message: 'All fields are required',
      fields: { email: !email, name: !name, password: !password }
    });
  }

  // Validate email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid email format'
    });
  }

  // Validate password length
  if (password.length < 6) {
    return res.status(400).json({
      success: false,
      message: 'Password must be at least 6 characters'
    });
  }

  const hash = bcrypt.hashSync(password);

  db.transaction(trx => {
    // First insert into users table
    return trx('users')
      .returning('*')
      .insert({
        email: email.toLowerCase(), // normalize email case
        name: name,
        joined: new Date()
      })
      .then(users => {
        const user = users[0];
        
        // Then insert into login table
        return trx('login')
          .insert({
            email: user.email, // use the same email as users table
            hash: hash
          })
          .then(() => {
            // Success - return the created user
            res.status(201).json({
              success: true,
              user: user
            });
          });
      })
      .then(trx.commit)
      .catch(err => {
        trx.rollback();
        throw err; // re-throw to be caught by outer catch
      });
  })
  .catch(err => {
    console.error('Registration error:', err);
    
    // Handle specific database errors
    if (err.code === '23505') { // Unique violation
      return res.status(400).json({
        success: false,
        message: 'Email already exists',
        field: 'email'
      });
    }

    res.status(500).json({
      success: false,
      message: 'Registration failed',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  });
});

// This route is used to retrieve a user’s profile based on their ID
app.get('/profile/:id', (req, res) => {
    const { id } = req.params;
    let found = false;
    db.select ('*').from('users').where
    ({ id})
    .then(user => {
        if (user.length) {
            res.json(user[0]);  
        } else {
            res.status(400).json('Not found');
}
       
    }) 
    .catch(err => res.status(400).json('Error getting users'));
});

// This receives an image URL and user ID and then runs face detection using Clarifai
app.put('/image', (req, res) => {
  const { id, input } = req.body;

  // First verify the user exists
  db.select('*').from('users').where('id', '=', id)
    .then(user => {
      if (user.length === 0) {
        return res.status(404).json('User not found');
      }

      // Updated Clarifai request with correct model ID and version
      const request = {
        model_id: "face-detection",  // Updated model ID
        version_id: "6dc7e46bc9124c5c8824be4822abe105",  // Specific version
        inputs: [{ data: { image: { url: input } }}]
      };

      stub.PostModelOutputs(
        request,
        metadata,
        (err, response) => {
          if (err) {
            console.error("Clarifai Error:", err);
            return res.status(500).json('Error processing image');
          }

          if (response.status.code !== 10000) {
            console.error("Clarifai Response Error:", response.status);
            return res.status(500).json('Error in face detection');
          }

          const faceRegions = response.outputs[0].data.regions || [];
          
          if (faceRegions.length === 0) {
            console.log("No faces detected");
            return res.json({
              entries: user[0].entries, // Return current entries
              clarifaiResponse: response
            });
          }

          // Update entries count if faces were detected
          db('users')
            .where('id', '=', id)
            .increment('entries', 1)
            .returning('entries')
            .then(entries => {
              res.json({
                entries: entries[0].entries,
                clarifaiResponse: response
              });
            })
            .catch(dbErr => {
              console.error("DB Error:", dbErr);
              res.status(500).json('Database error');
            });
        }
      );
    })
    .catch(err => {
      console.error("DB Query Error:", err);
      res.status(500).json('Database error');
    });
});

//This starts your Express server on port 3000 and logs a message to confirm it's running.
app.listen(3000, () => {
    console.log('App is running on port 3000');
});
