<?php

namespace App\Entity;

use Doctrine\ORM\Mapping as ORM;

#[ORM\Entity]
class Admin extends User
{
    #[ORM\Column(length: 32)]
    private string $role = 'editor';
}
